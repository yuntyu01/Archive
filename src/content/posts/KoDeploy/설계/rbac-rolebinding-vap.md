---
title: "권한을 좁히려면 권한이 더 필요했다 - RoleBinding과 VAP로 API 서버 권한 좁히기"
date: "2026-11-15"
description: "Argo CD로 옮긴 뒤에도 API 서버에는 모든 네임스페이스에 닿는 전역 권한 16개가 남았습니다. RoleBinding과 VAP로 테넌트 안에 가둬 6개로 줄였습니다."
tags: ["RBAC", "ValidatingAdmissionPolicy", "CEL", "Kubernetes"]
series: "KoDeploy"
thumbnail: "/images/thumbs/rbac-rolebinding-vap.webp"
---
> **요약**
>
> - Argo CD로 배포를 넘긴 뒤에도 API 서버(core)에 전역 권한 16개가 남아 모든 네임스페이스에 닿았습니다.
> - Secret 읽기는 admission을 거치지 않아 정책으로 막을 수 없어서, 권한을 네임스페이스마다 RoleBinding으로 걸었습니다.
> - 그러려면 core에 RoleBinding 생성 권한과 bind 권한이 전역으로 필요했고, 이 권한이면 core가 자기 권한을 다른 네임스페이스로 넓힐 수 있었습니다.
> - 이 권한을 ValidatingAdmissionPolicy(CEL)로 제한하고 네임스페이스 읽기와 삭제 권한까지 빼서 전역 권한을 6개로 줄였고, 남은 Pod exec는 테넌트별 Go 게이트웨이로 분리했습니다.

## 들어가는 글

[지난 글](/blog/argocd-declarative-deploy/)에서 배포 적용을 Argo CD로 넘기면서 API 서버(core)의 클러스터 전역 권한이 35개에서 16개로 줄었습니다. 권한 개수는 지난 글처럼 리소스 하나와 동작 하나의 조합을 1개로 셉니다.

| 묶음 | 권한 | 쓰는 곳 |
| --- | --- | --- |
| Secret | get, create, update, delete | 앱 환경변수, DB 비밀번호, 이미지 pull 인증 |
| 네임스페이스 | get, create, delete | 앱 생성과 삭제 |
| PVC | create | 앱 볼륨 |
| Pod | list, 로그 get, exec get, exec create | 상태 조회, 로그, 웹 터미널, DB 콘솔, 덤프, 복원 |
| Job | list | 빌드 실패 진단 |
| 노드 | list, `nodes/proxy` get | 관리자 화면의 노드 현황 |
| ResourceQuota | delete | 옛 quota 정리 (남은 것이 없어 이번에 제거) |

모두 Git에 적을 수 없는 작업이라 Argo CD로 옮길 수 없습니다. 문제는 이 권한이 ClusterRoleBinding으로 모든 네임스페이스에 걸려 있었다는 점입니다. core는 외부 요청을 받는 API 서버라서, 탈취되면 argocd나 kube-system의 Secret도 이름만 알면 읽을 수 있었습니다.

목표는 core의 토큰이 탈취되더라도 앱 네임스페이스 밖에는 닿지 못하게 하는 것입니다.

## 읽기는 RBAC으로만 좁힐 수 있다

처음에는 권한은 그대로 두고, core가 `tenant-*`와 `app-*` 네임스페이스만 다루게 하는 admission 정책을 검토했습니다. 그런데 admission은 생성, 수정, 삭제 요청에만 적용되고 읽기 요청(get, list, watch)에는 적용되지 않습니다. 가장 막고 싶었던 것이 다른 네임스페이스의 Secret 읽기라서 이 방법으로는 막을 수 없었습니다.

읽기 범위를 좁히려면 RBAC을 써야 합니다. ClusterRole을 ClusterRoleBinding으로 연결하면 모든 네임스페이스에, RoleBinding으로 연결하면 그 네임스페이스에만 적용됩니다. 그래서 core가 앱 네임스페이스 안에서 쓰는 권한을 ClusterRole `kodeploy-core-tenant`로 정의만 해 두고, 앱 네임스페이스를 만들 때마다 core가 그 안에 RoleBinding을 만들어 자신에게 연결하게 했습니다.

| 권한 | 쓰는 곳 |
| --- | --- |
| Secret get, create, update, delete | 앱 환경변수, DB 비밀번호, 이미지 pull 인증 |
| PVC create | 앱 볼륨 |
| Pod list | 상태, 로그, 터미널의 대상 Pod 찾기 |
| Pod 로그 get | 로그 화면 |
| Pod exec get, create | 웹 터미널, DB 콘솔, 덤프, 복원 |

```yaml
kind: RoleBinding
metadata:
  name: kodeploy-core
  namespace: app-<hex8>          # 방금 만든 앱 네임스페이스
roleRef:
  kind: ClusterRole
  name: kodeploy-core-tenant     # 정의는 클러스터에 하나
subjects:
  - kind: ServiceAccount
    name: kodeploy-core          # core 자신
    namespace: default
```

이 롤에는 Secret 읽기가 들어 있습니다. 그래서 이 롤이 어느 네임스페이스에서 누구에게 연결되느냐가 곧 누가 어느 Secret을 읽을 수 있느냐가 됩니다.

## 그러려면 권한이 더 필요했다

RoleBinding을 만드는 것도 API 요청이라 권한이 필요합니다. 게다가 RBAC은 권한 상승을 막기 위해, 롤을 연결하려는 쪽이 그 롤의 권한을 이미 모두 갖고 있거나 그 롤에 대한 `bind` 권한을 갖고 있어야 연결을 허용합니다. 새 네임스페이스에서 core는 아직 아무 권한이 없으므로 다음 세 권한이 클러스터 전역으로 있어야 합니다.

| 권한 | 필요한 이유 |
| --- | --- |
| `namespaces` create | 앱 네임스페이스를 만들어야 함 |
| `rolebindings` create | 새 네임스페이스에는 아직 권한이 없으니 전역으로 있어야 함 |
| `clusterroles` bind (`kodeploy-core-tenant`만) | 연결할 롤의 권한을 아직 갖고 있지 않음 |

이 권한은 RBAC만으로는 테넌트 네임스페이스로 좁힐 수 없습니다. RBAC은 이름이 정확히 같은 대상만 지정할 수 있어서 `app-`으로 시작하는 네임스페이스 같은 조건을 쓸 수 없고, 생성 요청에는 이름 지정이 아예 적용되지 않습니다.

결국 core는 자기 권한을 스스로 넓힐 수 있게 됩니다. core의 토큰이 탈취되면 다음 순서로 앱 네임스페이스 밖에 닿을 수 있습니다.

1. kube-system에 RoleBinding을 만들어 `kodeploy-core-tenant`를 core 자신에게 연결합니다. 세 권한이 모두 전역이라 RBAC은 이 요청을 허용합니다.
2. 그 RoleBinding으로 kube-system의 Secret을 읽습니다.

같은 방법으로 앱 네임스페이스의 권한을 다른 계정에 연결할 수도 있습니다. 지켜야 하는 것은 빌더 토큰이 있는 default, Git 접근 정보가 있는 argocd, kube-system처럼 플랫폼이 쓰는 네임스페이스입니다.

사용자 앱끼리의 격리는 이와 별개입니다. 앱 Pod에는 API 권한이 없고, 네트워크 정책이 자기 네임스페이스 밖의 내부 주소로 나가는 연결을 막아 다른 앱과 DB, API 서버에 닿지 못합니다. 이 글에서 다루는 것은 API 권한을 가진 core가 탈취됐을 때의 범위입니다.

## VAP로 요청 내용 검사

ValidatingAdmissionPolicy(VAP)는 RBAC 검사를 통과한 요청을 저장하기 직전에 내용을 검사해 거절하는 정책입니다. K8s 1.30부터 정식 기능이고, CEL 식으로 쓰며 API 서버 안에서 실행되므로 웹훅 서버가 필요 없습니다. 읽기와 달리 네임스페이스 생성과 RoleBinding 생성은 쓰기 요청이라 admission을 거칩니다.

정책은 core가 보낸 네임스페이스와 RoleBinding 요청에서 세 가지를 확인합니다.

| 확인하는 것 | 허용하는 것 |
| --- | --- |
| 위치 | 이름이 `app-<hex8>`, `tenant-<hex8>`인 네임스페이스만 만들고 지움. RoleBinding도 그 안에서만 만듦 |
| 받는 계정 | RoleBinding의 대상은 core 자신 하나뿐 |
| 연결하는 롤 | `kodeploy-core-tenant` 하나뿐 |

`tenant-`는 유저마다 네임스페이스를 하나씩 쓰던 예전 구조의 이름이고, `app-`은 앱마다 네임스페이스를 쓰는 지금 구조의 이름입니다.

```yaml
kind: ValidatingAdmissionPolicy
metadata:
  name: kodeploy-core-tenant-only
spec:
  failurePolicy: Fail          # 정책 평가가 실패하면 거절
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["namespaces"]
        operations: ["CREATE", "DELETE"]
      - apiGroups: ["rbac.authorization.k8s.io"]
        apiVersions: ["v1"]
        resources: ["rolebindings"]
        operations: ["CREATE", "UPDATE"]
  matchConditions:             # core가 보낸 요청만 본다
    - name: from-core
      expression: >-
        request.userInfo.username ==
        'system:serviceaccount:default:kodeploy-core'
  variables:
    - name: tenantName
      expression: "'^(tenant|app)-[0-9a-f]{8}$'"
  validations:
    # 네임스페이스는 테넌트 이름만 (삭제할 때는 삭제되는 객체의 이름)
    - expression: >-
        request.resource.resource != 'namespaces' ||
        (request.operation == 'DELETE'
          ? oldObject.metadata.name
          : object.metadata.name).matches(variables.tenantName)
    # RoleBinding은 테넌트 네임스페이스 안에서, 정해진 롤을, core 자신에게만
    - expression: >-
        request.resource.resource != 'rolebindings' ||
        (request.namespace.matches(variables.tenantName) &&
         object.roleRef.kind == 'ClusterRole' &&
         object.roleRef.name == 'kodeploy-core-tenant' &&
         size(object.subjects) == 1 &&
         object.subjects.all(s,
           s.kind == 'ServiceAccount' &&
           s.name == 'kodeploy-core' &&
           s.namespace == 'default'))
```

`matchConditions`로 core가 보낸 요청만 검사해서 관리자나 Argo CD의 요청에는 영향이 없습니다. `failurePolicy: Fail`은 식을 평가하다 오류가 나면 거절하는 설정으로, 정책이 오작동해도 허용 쪽으로 넘어가지 않게 했습니다. 이제 core가 탈취되더라도 다음 요청은 거절됩니다.

- kube-system, argocd 같은 네임스페이스에 RoleBinding 생성
- 앱 네임스페이스의 권한을 다른 계정에 연결하는 RoleBinding 생성
- `argocd-x`, `evil-ns` 같은 이름의 네임스페이스 생성

## nodes/proxy 대신 nodes/stats

같은 날 노드 권한도 줄였습니다. 관리자 화면의 노드 사용량을 읽으려고 `nodes/proxy`를 쓰고 있었는데, 이 권한은 kubelet API 전체를 열어 모든 노드에서 컨테이너 exec까지 가능하게 합니다. kubelet의 `/stats/summary`를 직접 호출하도록 바꾸고, 권한은 통계만 읽는 `nodes/stats`로 줄였습니다. kubelet 인증서는 노드마다 다른 자체 서명 CA로 발급되므로, CA를 모은 ConfigMap으로 검증하고 인증서 검증은 끄지 않았습니다.

## 적용과 검증

RoleBinding은 만들자마자 적용된다고 가정하면 안 됩니다. API 서버가 권한을 판단할 때 RoleBinding 목록을 캐시해 쓰기 때문입니다. 그래서 core는 Secret을 만들기 전에 SelfSubjectAccessReview로 권한이 반영됐는지 확인하고, 허용될 때까지 0.5초 간격으로 최대 15초 기다립니다. 운영에서는 0.07초 만에 반영됐습니다.

10월 31일 운영 반영은 VAP를 먼저 적용하고, 옛 권한과 새 권한을 합친 RBAC을 건 뒤, 기존 테넌트 네임스페이스 10개에 RoleBinding을 추가하고 새 core를 배포한 다음, 마지막에 옛 전역 권한을 뺐습니다. VAP를 먼저 둔 것은 core가 RoleBinding을 만들 수 있게 되기 전에 제한이 있어야 하기 때문이고, 옛 권한을 마지막에 뺀 것은 그 사이의 배포가 `403`으로 실패하지 않게 하기 위해서입니다.

검증은 core 계정으로 위장해서 했습니다. 권한은 `kubectl auth can-i`로, VAP는 server dry-run으로 확인했습니다. server dry-run은 admission까지 거치고 저장만 하지 않아서 운영에서도 안전하게 정책을 시험할 수 있습니다.

```bash
SA=system:serviceaccount:default:kodeploy-core
kubectl auth can-i get secrets -n kube-system --as=$SA   # no
kubectl auth can-i get secrets -n app-<hex8>  --as=$SA   # yes
kubectl auth can-i get nodes --subresource=stats --as=$SA   # yes
kubectl create namespace evil-ns --dry-run=server --as=$SA   # VAP가 거절
```

argocd, kube-system, default, monitoring의 Secret 읽기와 exec는 거부되고 테넌트 네임스페이스에서는 허용됐습니다. 노드 현황, 로그, 터미널, 환경변수 수정, 앱 삭제를 실제로 실행해 봤고, 반영 후 core 로그의 `403`은 0건이었습니다.

## 이후에 줄인 권한

11월 8일에는 네임스페이스 get과 delete를 전역 권한에서 뺐습니다. 삭제는 테넌트 롤로 옮겼는데, 네임스페이스 안의 RoleBinding이 주는 삭제 권한은 그 네임스페이스 자신에만 적용되기 때문입니다. 읽기 권한이 없어져서, 삭제 중인 네임스페이스는 그 안의 RoleBinding 생성이 `NamespaceTerminating` 사유의 `403`으로 거절되는 것으로 판단하도록 바꿨습니다. 전역 권한은 8개에서 6개가 됐습니다.

11월 13~14일에는 테넌트 롤에 남은 Pod exec를 뺐습니다. exec는 네임스페이스 안의 모든 Pod에서 임의의 명령을 실행할 수 있어서, core가 탈취되면 사용자 DB에 접속할 수 있었습니다. 테넌트 네임스페이스마다 Go로 만든 작은 exec 게이트웨이를 두고, DB 콘솔과 덤프, 복원은 core가 서명한 요청으로, 웹 터미널은 core가 받아 준 1회용 티켓으로 게이트웨이에 맡겼습니다. 게이트웨이는 정해진 작업만 받고 Secret 권한이 없으며, 내부 엔드포인트는 core Pod에서만 접근할 수 있습니다. 제거는 `can-i` 대신 실제 exec 요청으로 확인했습니다. exec는 GET으로 연결을 시작하지만 권한은 create로 판정되어 `can-i` 결과가 실제와 다를 수 있기 때문입니다.

## 결과

![core 권한이 닿는 범위](/images/posts/rbac-rolebinding-vap/01.png)

| 시점 | 전역 | 테넌트 네임스페이스 | 빌드 네임스페이스 | core 탈취 시 닿는 범위 |
| --- | --- | --- | --- | --- |
| Argo CD 이전 직후 (10/31) | 16 | - | - | 모든 네임스페이스의 Secret, Pod exec, kubelet API |
| RoleBinding + VAP (10/31) | 8 | 9 | 6 | 테넌트 네임스페이스 안의 Secret, Pod exec |
| 네임스페이스 읽기, 삭제 제거 (11/8) | 6 | 10 | 6 | 위와 같음. 네임스페이스 삭제도 자기 것만 가능 |
| exec 게이트웨이 (11/13~14) | 6 | 8 | 6 | 테넌트 네임스페이스 안의 Secret (Pod exec 없음) |

권한 개수의 합은 16개에서 20개로 늘었지만, 각 권한이 적용되는 범위는 테넌트 네임스페이스와 빌드 네임스페이스로 좁아졌습니다. 남은 전역 권한 6개 중 쓰기 세 개(네임스페이스 생성, RoleBinding 생성, bind)는 VAP로 제한되고, 나머지 세 개(Pod 목록, 노드 목록, 노드 통계)는 읽기 권한입니다.

## 한계

- core가 탈취되면 게이트웨이를 거친 셸은 여전히 열 수 있습니다. 서명 키를 core가 갖고 있기 때문입니다. 다만 대상은 그 테넌트의 앱, DB, Redis이고 작업도 정해진 목록뿐입니다. 토큰만 유출됐다면 K8s API로도 게이트웨이로도 exec할 수 없습니다.
- core는 여전히 테넌트 Secret을 읽고 씁니다. 환경변수 수정을 core가 처리하기 때문에, 테넌트 데이터에 대한 신뢰는 core에 남아 있습니다.
- 전역 쓰기 권한 세 개는 VAP에 기대고 있어서, 정책이나 바인딩이 지워지면 다시 열립니다. 지울 수 있는 것은 클러스터 관리자뿐입니다.
- 전역 Pod 목록 조회는 관리자 화면의 노드별 리소스 합계 때문에 남겼습니다. 모든 네임스페이스의 Pod 명세(이미지, env에 직접 적은 값)를 볼 수 있습니다.
- 11/8에 바꾼 Terminating 대기와 고아 네임스페이스 정리는 로컬 클러스터에서만 확인했습니다.
- RoleBinding을 거는 일을 별도 컨트롤러로 옮기면 core에서 RoleBinding 생성과 bind 권한도 뺄 수 있지만, 컴포넌트가 하나 늘어서 이번에는 VAP에서 멈췄습니다.
