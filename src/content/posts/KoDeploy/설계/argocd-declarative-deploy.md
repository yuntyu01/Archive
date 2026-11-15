---
title: "patch로는 지울 수 없었다 - 명령형 배포를 Argo CD 선언형 배포로"
date: "2026-11-14"
description: "사용자가 런타임을 바꿔 재배포하자 Service가 422로 막혔습니다. 옛 포트를 지우지 못하는 patch 배포를 Argo CD 선언형 배포로 바꾸면서 API 서버 전역 권한을 35개에서 16개로 줄였고, 이어서 6개까지 줄였습니다."
tags: ["Argo CD", "Server-Side Apply", "GitOps", "Kubernetes"]
series: "KoDeploy"
thumbnail: "/images/thumbs/argocd-declarative-deploy.webp"
---
> **요약**
>
> - 사용자가 런타임을 바꿔 재배포하자 Service가 `422`로 거부됐습니다. strategic merge patch가 옛 포트를 남긴 게 원인이었습니다.
> - core가 보내는 patch에는 이제 없어야 할 값이 담기지 않았고, 그동안 replace 분기를 하나씩 늘려 온 것도 같은 이유였습니다.
> - replace 분기 추가, core에서 server-side apply, Argo CD를 비교해 Argo CD로 옮겼습니다.
> - 운영 앱 10개를 재생성 없이 넘긴 뒤 기존 배포 코드 3.9천 줄을 지웠고, API 서버의 클러스터 전역 권한은 35개에서 16개로, 이어서 6개로 줄었습니다.

## 들어가는 글

KoDeploy는 GitHub 링크를 넣으면 빌드부터 배포까지 해 주는 K8s 기반 멀티테넌시 PaaS입니다. 이 글은 배포의 마지막 단계인, 만들어진 이미지를 클러스터에 적용하는 부분을 다룹니다.

원래 구조는 단순했습니다. API 서버(core, Python)가 Jinja 템플릿으로 Deployment, Service, HTTPRoute, NetworkPolicy를 만들고 K8s API를 직접 불러 적용합니다. 리소스가 없으면 create하고, 있으면 patch나 replace를 합니다.

![Argo CD 이전의 배포 구조](/images/posts/argocd-declarative-deploy/01.png)

처음에는 Argo CD를 일부러 쓰지 않았습니다. 원하는 상태는 DB에 있고 실행은 K8s가 맡으며, 상태가 어긋나면 core가 다음 배포 때 다시 맞추니 Argo CD의 reconcile과 역할이 겹친다고 봤습니다. 이 글의 절반은 그 판단이 어디서 틀렸는지에 대한 이야기입니다.

## 포트 변경 배포에서 난 Service 422 (7/15)

7월 15일, 한 사용자가 운영 중이던 자기 앱을 Java(8080)에서 JavaScript(3000)로 바꿔 다시 배포했는데, Service 업데이트가 `422`로 거부됐습니다.

core는 Service를 strategic merge patch로 갱신하고 있었습니다. `Service.spec.ports`는 포트 번호를 병합 키로 쓰기 때문에, 3000을 보내면 API 서버는 8080 항목을 3000으로 바꾸지 않고 3000 항목을 하나 더 추가합니다.

```yaml
# core가 보낸 것
spec:
  ports:
    - port: 3000
      targetPort: 3000

# 병합 결과 (병합 키 = port)
spec:
  ports:
    - port: 8080      # 지우라고 보낸 적이 없으니 남는다
      targetPort: 8080
    - port: 3000
      targetPort: 3000
```

포트가 두 개인 Service는 포트마다 이름이 있어야 하는데, 템플릿의 포트에는 이름이 없어서 요청이 거부됐습니다.

나중에 로컬에서 재현해 보니 Service가 거부될 때 Deployment는 이미 3000으로 바뀌어 있었습니다. core는 Deployment, Service, HTTPRoute 순서로 API를 하나씩 불렀기 때문에, 중간에 하나가 실패하면 앞의 것만 바뀐 채로 멈춥니다. 컨테이너는 3000에서 요청을 받는데 Service는 계속 8080으로 보내니 앱이 응답하지 않았습니다.

그날은 Service를 읽은 뒤 포트 목록을 통째로 바꿔 끼우는 replace로 고쳤습니다. 고치고 나서 보니 비슷한 분기가 이미 여러 개 있었습니다.

## patch, replace, apply의 동작

K8s API로 이미 있는 객체를 바꾸는 방법은 크게 세 가지입니다. 바꿀 부분만 보내는 patch, 객체 전체를 보내는 replace, 원하는 상태 전체를 보내고 차이 계산은 API 서버에 맡기는 server-side apply(SSA)입니다. patch는 다시 형식이 몇 가지로 나뉘는데, 자주 쓰는 것은 strategic merge patch와 JSON merge patch입니다.

Service 포트를 8080에서 3000으로 바꾸는 같은 요청을 각 방식으로 보내면 결과가 이렇게 갈립니다. 처음부터 같은 방식으로 적용해 왔다고 가정합니다.

| 방식 | 보내는 내용 | 결과 |
| --- | --- | --- |
| strategic merge patch | 포트 목록에 3000 하나 | 8080과 3000이 둘 다 남음. 포트 번호로 항목을 맞춰 합치는데, 8080은 이번 요청에 없어서 그대로 둠 |
| JSON merge patch | 포트 목록에 3000 하나 | 3000만 남음. 목록은 합치지 않고 통째로 바꿈 |
| replace | 읽어 온 Service에서 포트만 바꾼 객체 전체 | 3000만 남음. 보낸 객체가 그대로 새 상태가 됨 |
| server-side apply | 원하는 Service 전체와 보내는 주체 이름 | 3000만 남음. core가 지난번에 보낸 8080이 이번에 빠져서 API 서버가 지움 |

patch로도 값을 지울 수는 있습니다. strategic merge patch라면 8080 항목에 `$patch: delete`를 붙여 함께 보내면 됩니다. 다만 무엇을 지울지 클라이언트가 직접 적어 보내야 하고, 그러려면 지난번에 무엇을 보냈는지 알아야 합니다. `kubectl apply`(클라이언트 쪽 apply)가 객체에 `kubectl.kubernetes.io/last-applied-configuration` 주석으로 지난번 설정을 남겨 두고, 이번 설정과 비교해 삭제 지시어를 만들어 보내는 이유가 이것입니다. core는 지금 원하는 상태만 strategic merge patch로 보냈고 지난번에 보낸 내용은 기록하지 않았기 때문에, 빠져야 할 값을 patch에 담을 방법이 없었습니다.

server-side apply는 이 기록을 API 서버가 대신 남깁니다. 클라이언트는 `fieldManager`라는 이름을 붙여 원하는 상태를 보내고, API 서버는 객체의 `metadata.managedFields`에 어느 이름이 어느 필드를 썼는지 필드 단위로 적어 둡니다. Service 포트처럼 키가 있는 목록은 항목마다 따로 기록합니다.

```yaml
metadata:
  managedFields:
    - manager: core            # 적용한 주체 (fieldManager)
      operation: Apply
      fieldsV1:
        f:spec:
          f:ports:
            k:{"port":8080,"protocol":"TCP"}: {}   # 이 포트 항목은 core 소유
```

다음에 core가 3000만 담아 다시 apply하면, API 서버는 core가 지난번에 소유했던 8080 항목이 이번 요청에 없다는 것을 알고 지웁니다. 다른 주체도 같이 소유한 필드라면 지우지 않고 남겨 둡니다. 반대로 다른 주체가 소유한 필드를 다른 값으로 바꾸려 하면 충돌(409)로 거절되고, 강제로 가져오려면 `force` 옵션을 줘야 합니다. `kubectl apply`는 지난번 설정을 클라이언트가 주석 하나에 남기지만, SSA는 API 서버가 필드와 주체 단위로 기록합니다. 그래서 여러 주체가 한 객체를 나눠 써도 서로의 필드를 건드리지 않고, 클라이언트는 지난번에 무엇을 보냈는지 기억할 필요가 없습니다.

명령형과 선언형의 차이도 여기서 나옵니다. core처럼 create, patch, replace 중 무엇을 어떻게 보낼지 클라이언트가 매번 고르는 방식이 명령형이고, 원하는 상태 전체를 넘기면 서버나 컨트롤러가 지금 상태와의 차이를 계산하는 방식(SSA, Argo CD)이 선언형입니다.

## 늘어나던 replace 분기

기존 적용 코드에서 평소에는 patch를 쓰고 특정 경우에만 replace를 쓰는 곳을 모으면 다음과 같습니다.

| 리소스 | 평소 | 예외 | 예외가 생긴 이유 |
| --- | --- | --- | --- |
| Deployment | 이미지만 patch | 런타임, 포트, 볼륨 경로가 바뀌면 통째로 replace | patch로는 probe와 리소스 설정에 옛 값이 남고, 볼륨은 추가만 되고 빠지지 않음 |
| Service | patch | 7/15부터 항상 읽은 뒤 통째로 replace | 옛 포트가 남음 |
| HTTPRoute | 없으면 create | 있으면 rules만 patch | 호스트 목록은 다른 코드가 따로 관리 |
| NetworkPolicy | 없으면 create | 있으면 그대로 둠 | - |

예외가 생긴 이유는 모두 같습니다. core가 보내는 patch에는 지금 원하는 값만 들어 있어서, 빠져야 하는 값은 그대로 남습니다. 그래서 무언가 빠져야 하는 변경이 생길 때마다 그 경우만 replace로 돌리는 분기를 추가해 왔습니다.

전부 replace로 바꾸기도 어렵습니다. replace는 보낸 객체로 전체를 바꾸기 때문에, 다른 컨트롤러가 쓴 필드처럼 core가 모르는 값까지 담아 보내지 않으면 그 값이 지워집니다. 그래서 Service는 현재 객체를 먼저 읽고 포트 목록만 고쳐서 보내도록 짰습니다.

같은 원인에서 나온 문제가 두 가지 더 있었고, 둘 다 로컬에서 재현해 확인했습니다.

- 플랫폼 정책이 기존 앱에 반영되지 않습니다. 런타임의 메모리 상한을 바꾸거나 NetworkPolicy에 규칙을 추가해도, 같은 런타임과 포트로 다시 배포하면 이미지만 patch되고 NetworkPolicy는 이미 있으면 건드리지 않으니 옛 값이 남습니다.
- 클러스터에서 누군가 손으로 바꾼 값이 원래대로 돌아오지 않습니다. core는 배포할 때 자기가 보내는 필드만 맞춥니다.

처음에 core가 어긋난 상태를 다시 맞춘다고 본 것은 배포할 때, 그것도 core가 보내는 필드에 한한 이야기였습니다. Argo CD의 reconcile과 겹친다고 본 판단도 여기서 틀렸습니다.

권한 문제도 있었습니다. core가 리소스를 직접 적용하려면 그 리소스를 쓸 권한이 있어야 해서, 외부 요청을 받는 API 서버가 클러스터 전역 권한을 35개 갖고 있었습니다. Deployment, StatefulSet, Service, HTTPRoute, NetworkPolicy, Job 쓰기와 모든 네임스페이스의 Secret 읽기, Pod exec가 여기에 포함됩니다. 권한 개수는 리소스 하나와 동작 하나의 조합을 1개로 셉니다.

배포가 깨지는 문제와 권한 문제는 따로 보이지만 뿌리가 같습니다. core는 원하는 상태를 정하는 데서 그치지 않고, 리소스마다 create, patch, replace 중 무엇으로 바꿀지까지 정해 직접 실행하는 명령형 적용자였습니다. 바꾸는 방법을 core가 정하니 지울 값을 빠뜨리면 그대로 장애가 됐고, core가 직접 실행하니 외부 요청을 받는 서버가 클러스터 쓰기 권한을 들고 있어야 했습니다. 그래서 한쪽만 고치는 방법으로는 부족했고, core에서 적용하는 역할 자체를 떼어 내야 둘 다 풀렸습니다. 세 가지 대안도 이 기준으로 비교했습니다.

## 세 가지 대안

| | A. replace 분기 계속 추가 | B. core에서 server-side apply | C. Argo CD |
| --- | --- | --- | --- |
| 필드 삭제 (7/15 같은 경우) | 변경 유형마다 분기 | 해결 | 해결 |
| 리소스 삭제 (정적 슬롯을 끄면 Service가 사라져야 함) | 직접 구현 | 직접 구현 | prune |
| 플랫폼 정책 반영 | 앱마다 재배포와 분기 | 앱마다 재배포 | 차트를 고치면 전체 앱에 반영 |
| 손으로 바꾼 값 복원 | 없음 | 주기적으로 다시 적용하는 루프를 직접 구현 | selfHeal |
| 적용 주체 | 외부 요청을 받는 core | 외부 요청을 받는 core | 외부 요청이 닿지 않는 Argo CD |
| 추가되는 것 | 없음 | 없음 | Argo CD 컴포넌트, Git 저장소 2개 |

처음에는 B가 가장 나아 보였습니다. 새 컴포넌트 없이 적용 방식만 SSA로 바꾸면 7/15 같은 문제가 풀리고, 코드도 거의 그대로 둘 수 있었습니다.

하지만 B는 표의 첫 줄만 해결합니다. 외부 요청을 받는 core가 쓰기 권한을 그대로 들고 있어야 하고, 리소스 삭제와 재적용 루프도 직접 만들어야 했습니다. 이것까지 만들면 core 안에 Argo CD를 하나 더 만드는 것과 비슷해서 부담이 적지 않았습니다.

## Argo CD를 고른 이유

필요했던 것은 원하는 상태 전체를 적어 두면 현재 상태와 비교해서, 없어야 할 리소스까지 지우고, 그 상태를 계속 유지하는 기능이었습니다. reconcile 컨트롤러가 하는 일입니다. 처음에 Argo CD를 쓰지 않은 이유가 reconcile이 겹친다는 것이었는데, core의 reconcile이 배포 시점에만 동작한다는 걸 확인하고 나니 오히려 Argo CD를 쓸 이유가 됐습니다.

권한 문제도 같은 전환으로 풀립니다. 적용 주체가 외부 요청을 받는 core에서 외부 요청이 닿지 않는 Argo CD로 바뀌어, core에는 워크로드를 쓸 권한이 필요 없어집니다. core는 앱별 이미지와 포트 같은 값만 Git에 남기고, 매니페스트의 형태는 고정된 차트가 정합니다. Argo CD가 무엇을 어디에 만들 수 있는지도 AppProject로 제한했습니다. 배포 대상은 `tenant-*`와 `app-*` 네임스페이스, 소스는 차트 저장소와 값 저장소 두 개, 만들 수 있는 리소스 종류는 정해 둔 목록으로 한정했습니다.

비용도 있습니다. 클러스터에 Argo CD 컴포넌트가 늘어납니다. 웹 UI 서버는 빼고 배포에 필요한 application-controller, applicationset-controller, repo-server, Redis만 설치했습니다. 반영이 Git 커밋을 거치면서 단계도 하나 늘어납니다. 이 지연을 줄이려고 빌더가 커밋 직후 Application에 refresh를 요청하고 Synced와 Healthy가 될 때까지 기다리게 했습니다. 그래서 Git 폴링 주기를 기다리지 않습니다.

## 저장소와 책임 나누기

저장소는 역할에 따라 세 개로 나눴습니다.

| 저장소 | 역할 | 들어가는 것 |
| --- | --- | --- |
| `kodeploy` | 플랫폼 | core, 빌더, 웹, 설치 자동화 |
| `kodeploy-charts` | 앱을 배포하는 형태 | Helm 차트, 플랫폼 정책(`platform/`), AppProject |
| `kodeploy-apps` | 앱마다 배포할 값 | 앱별 `values.yaml` (이미지 digest, 런타임, 포트, 도메인) |

비밀번호 같은 Secret 값은 Git에 넣지 않고 core가 클러스터에 직접 씁니다. `kodeploy-apps`에는 사용자 ID와 도메인이 들어 있어서 비공개 저장소로 뒀습니다.

차트 안에서도 정하는 주체를 나눴습니다. 앱 이름, 이미지, 런타임 같은 앱별 값은 values에 두고, 런타임별 기본 포트와 메모리 상한 같은 플랫폼 정책은 `platform/`에, 리소스의 형태는 `templates/`에 둡니다. values 스키마는 정해진 필드 외의 값을 받지 않기 때문에(`additionalProperties: false`) 앱 values로 플랫폼 정책을 덮어쓸 수 없습니다.

배포 한 번의 흐름은 다음과 같이 바뀌었습니다.

![Argo CD로 옮긴 뒤의 배포 흐름](/images/posts/argocd-declarative-deploy/02.png)

ApplicationSet은 `kodeploy-apps`의 `apps/*` 폴더 하나마다 Application을 하나씩 만듭니다. 주요 설정은 다음과 같습니다.

```yaml
spec:
  syncPolicy:
    preserveResourcesOnDeletion: true   # Application을 지워도 앱 리소스는 남긴다
  template:
    spec:
      syncPolicy:
        automated:
          prune: true                   # Git에서 빠진 리소스는 지운다
          selfHeal: true                # 클러스터에서 바뀐 값은 Git 쪽으로 되돌린다
        syncOptions:
          - ServerSideApply=true
```

`preserveResourcesOnDeletion`은 이관 때문에 넣었습니다. 이관 도중 문제가 생겨 Argo CD 관리를 해제할 때, Application을 지우면서 앱 서버와 DB까지 함께 지워지는 일을 막기 위해서입니다.

## 운영 앱을 재생성 없이 이관하기

운영 중인 앱 10개는 대부분 DB 데이터가 있어서 지우고 다시 만들 수 없었습니다.

리소스 이름이 기존 코드와 같았기 때문에, Argo CD가 server-side apply로 적용하면 기존 객체를 새로 만들지 않고 그대로 넘겨받습니다.

문제는 managedFields였습니다. SSA는 필드마다 소유자를 기록하는데, core와 Argo CD가 같은 값을 쓴 필드는 둘의 공동 소유로 남습니다. 이 상태에서는 나중에 차트에서 그 필드를 빼도 core의 소유 기록이 남아 있어서 지워지지 않습니다(ConfigMap으로 재현해 확인했습니다). 그래서 Argo CD가 처음 적용한 뒤에 managedFields에서 core 항목만 지웠습니다. 그러면 Argo CD 단독 소유가 되고, 재시작이나 OutOfSync도 생기지 않습니다. Argo CD가 적용하기 전에 지우면 적용하면서 공동 소유가 다시 생기기 때문에 순서를 지켜야 했습니다.

이관 결과는 다음과 같습니다.

- 운영 앱 10개를 모두 Argo CD로 넘겼습니다. 앱마다 Synced와 Healthy 상태, managedFields의 core 항목 0개, 응답 본문의 확인용 문자열, DB 행 수를 이관 전후로 비교했습니다.
- 차트의 리소스 설정이 기존 값과 달라서 앱과 DB Pod가 한 번씩 재시작됐습니다. DB가 다시 뜨는 동안 앱이 DB 주소를 찾지 못해 1~2번 재시작했고, 앱마다 1분 미만의 중단이 있었습니다. 볼륨과 데이터는 그대로였습니다.
- 10개 앱이 새 경로로 정상 동작하는 것을 확인한 뒤 기존 배포 경로를 지웠습니다. 삭제한 코드는 3,951줄입니다.

## 로컬에서 장애 재현

운영과 같은 버전(K8s 1.35, Argo CD 3.5.3)의 로컬 클러스터를 띄우고, 네임스페이스 세 개에 7/15 수정 전 코드, 기존 최종 코드, 새 경로를 각각 올린 뒤 같은 변경을 적용했습니다. 성공 여부는 앱 응답 본문에 넣어 둔 확인용 문자열로 판정했습니다. 응답 코드가 200이어도 다른 Pod가 응답했다면 실패로 처리하기 위해서입니다.

| 시나리오 | 기존 코드 | Argo CD |
| --- | --- | --- |
| 포트 변경 (java 8080 → javascript 3000) | 7/15 수정 전: Service `422`, Deployment만 바뀌어 응답 없음. 수정 후: 정상(replace 분기) | 분기 없이 정상 |
| 플랫폼 정책 변경 (메모리 상한, NetworkPolicy 규칙 추가) | 같은 설정으로 재배포해도 옛 값 유지 | 차트 커밋만으로 약 1분 안에 전체 앱에 반영 |
| 클러스터에서 값 직접 수정 (targetPort, 메모리, env 추가) | 복원되지 않음. 재배포하면 targetPort만 복원 | targetPort 6초, 메모리 9초 만에 복원. 추가한 env는 남음 |

마지막 줄에서 추가한 env가 남은 것은 selfHeal이 되돌리는 범위가 Argo CD가 소유한 필드로 한정되기 때문입니다. 손으로 추가한 `DEBUG` env는 managedFields에 `kubectl` 소유로 기록돼서 Argo CD가 차이로 보지 않고, 상태도 Synced로 유지됩니다.

이 부분은 권한으로 막았습니다. 운영에서 Argo CD 밖에서 워크로드에 필드를 추가할 수 있는 주체는 core, 사용자, 클러스터 관리자입니다. core는 워크로드 쓰기 권한이 없어졌고 사용자에게는 kubectl 접근이 없으니, 남는 것은 클러스터 관리자뿐입니다. Git에 적힌 상태가 실제 상태와 같다고 하려면, selfHeal이 되돌리는 범위와 그 밖의 쓰기 경로를 막는 권한을 함께 봐야 합니다.

## 남은 권한

적용을 Argo CD로 넘기고 기존 경로를 지우면서 core의 클러스터 전역 권한은 35개에서 16개가 됐습니다.

| 묶음 | 권한 | 쓰는 곳 | Argo CD 전환 후 |
| --- | --- | --- | --- |
| Deployment | get, create, update, patch, delete, 상태 get | 앱 배포, 환경변수 변경 뒤 재기동, 롤아웃 대기 | 빠짐 |
| StatefulSet | create, delete | MySQL, PostgreSQL | 빠짐 |
| Service | get, create, update, delete | 앱 Service | 빠짐 |
| HTTPRoute | create, patch, delete | 앱 서브도메인, 커스텀 도메인 | 빠짐 |
| NetworkPolicy | create | 테넌트 격리 | 빠짐 |
| Job | create, delete, 상태 get | 빌드 제출, 재빌드 전 정리, 완료 판정 | 빠짐 (빌드는 빌더로 이전) |
| Job | list | 빌드 실패 진단 | 남음 |
| Secret | get, create, update, delete | 앱 환경변수, DB 비밀번호, 이미지 pull 인증 | 남음 |
| 네임스페이스 | get, create, delete | 앱 생성과 삭제 | 남음 |
| PVC | create | 앱 볼륨 | 남음 |
| ResourceQuota | delete | 옛 quota 정리 | 남음 |
| Pod | list, 로그 get, exec get, exec create | 상태 조회, 로그, 웹 터미널, DB 콘솔 | 남음 (exec는 이후 게이트웨이로 분리) |
| 노드 | list, `nodes/proxy` get | 관리자 화면의 노드 현황 | 남음 |

빠진 19개는 워크로드와 빌드 Job을 만들고 고치는 권한입니다. 남은 16개는 비밀번호나 터미널처럼 Git에 적을 수 없는 작업에 쓰입니다. 이 권한들은 모든 네임스페이스에 걸려 있어서, argocd나 kube-system의 Secret도 이름만 알면 읽을 수 있었습니다.

이 16개는 Argo CD로 옮길 수 없어서 적용 범위를 테넌트 네임스페이스 안으로 좁혔습니다. Secret 읽기는 admission 정책이 검사하지 않는 요청이라, 네임스페이스마다 RoleBinding으로 권한을 걸었습니다. 그러려면 core가 새 네임스페이스에 RoleBinding을 만들 권한이 전역으로 필요한데, 이 권한이면 core가 kube-system에도 자기 RoleBinding을 만들 수 있습니다. RBAC으로는 이를 `app-*` 네임스페이스로 좁힐 수 없어서, ValidatingAdmissionPolicy로 core의 RoleBinding은 앱 네임스페이스 안에서 자기 자신에게만 만들 수 있게 제한했습니다. 이렇게 전역 권한을 8개로 줄였고, 이후 네임스페이스 읽기와 삭제 권한도 빼서 6개가 됐습니다. 테넌트 안에 남은 Pod exec는 테넌트별 게이트웨이로 분리했습니다. 자세한 과정은 [다음 글](/blog/rbac-rolebinding-vap/)에 정리했습니다.

| 시점 | 전역 | 네임스페이스 한정 | core 탈취 시 닿는 범위 |
| --- | --- | --- | --- |
| core가 직접 적용 | 35 | 0 | 모든 네임스페이스의 워크로드 쓰기, Secret, Pod exec, kubelet |
| Argo CD로 이전 | 16 | 0 | 모든 네임스페이스의 Secret, Pod exec, kubelet |
| 테넌트 RoleBinding + VAP, 네임스페이스 권한 정리 | 6 | 테넌트 10, 빌드 6 | 테넌트 네임스페이스 안의 Secret, Pod exec |
| exec 게이트웨이 | 6 | 테넌트 8, 빌드 6 | 테넌트 네임스페이스 안의 Secret (Pod exec 없음) |

## 한계

- Argo CD가 배포 경로의 핵심 부품이 됐습니다. Argo CD가 멈추면 새 배포와 정책 반영도 멈춥니다. 이미 실행 중인 앱은 영향을 받지 않습니다.
- selfHeal은 Argo CD가 소유한 필드만 되돌립니다. 앞에서 본 것처럼 나머지는 권한으로 막아야 합니다.
