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
> - 그러려면 core에 RoleBinding 생성 권한과 bind 권한이 전역으로 필요했고, RBAC으로는 이를 테넌트 네임스페이스로 한정할 수 없었습니다.
> - 이 권한을 ValidatingAdmissionPolicy(CEL)로 제한해 전역 권한을 6개로 줄였고, 남은 Pod exec는 테넌트별 Go 게이트웨이로 분리했습니다.

## 들어가는 글

[지난 글](/blog/argocd-declarative-deploy/)에서 배포 적용을 Argo CD로 넘기면서 API 서버(core)의 클러스터 전역 권한이 35개에서 16개로 줄었습니다. 이 글은 남은 16개를 줄인 과정입니다. 권한 개수는 지난 글처럼 리소스 하나와 동작 하나의 조합을 1개로 셉니다.

| 묶음 | 권한 | 쓰는 곳 |
| --- | --- | --- |
| Secret | get, create, update, delete | 앱 환경변수, DB 비밀번호, 이미지 pull 인증 |
| 네임스페이스 | get, create, delete | 앱 생성과 삭제 |
| PVC | create | 앱 볼륨 |
| Pod | list, 로그 get, exec get, exec create | 상태 조회, 로그, 웹 터미널, DB 콘솔, 덤프, 복원 |
| Job | list | 빌드 실패 진단 |
| 노드 | list, `nodes/proxy` get | 관리자 화면의 노드 현황 |
| ResourceQuota | delete | 옛 quota 정리 (남은 것이 없어 이번에 제거) |

모두 Argo CD로 옮길 수 없는 작업입니다. 비밀번호는 Git에 적을 수 없고, 터미널은 선언할 상태가 없는 일회성 동작입니다.

문제는 이 권한이 ClusterRoleBinding으로 걸려 모든 네임스페이스에 적용됐다는 점입니다. core는 외부 요청을 받는 API 서버라서, 탈취되면 argocd나 kube-system의 Secret도 이름만 알면 읽을 수 있고 어떤 Pod에서든 exec할 수 있었습니다. `nodes/proxy`는 kubelet API 전체를 여는 권한이라 kubelet을 거쳐 노드 위의 모든 컨테이너에서 명령을 실행할 수도 있었습니다.

## admission 정책만으로는 읽기를 막을 수 없다

처음 검토한 방법은 admission 정책이었습니다. 권한은 그대로 두고, core는 `tenant-*`와 `app-*` 네임스페이스만 다룰 수 있다는 정책을 추가하는 방식입니다.

그런데 admission은 객체를 만들거나 수정하거나 삭제하는 요청에만 적용되고, 읽기 요청(get, list, watch)에는 적용되지 않습니다. 가장 막고 싶었던 것이 다른 네임스페이스의 Secret 읽기였기 때문에 이 방법으로는 해결되지 않았습니다.

읽기를 네임스페이스 단위로 제한하려면 RBAC을 써야 합니다. 권한을 ClusterRoleBinding 대신 네임스페이스마다 RoleBinding으로 거는 방법입니다.

## RoleBinding으로 네임스페이스마다 권한 걸기

RBAC은 권한 묶음을 정의하는 Role, ClusterRole과, 그 묶음을 누구에게 어느 범위로 줄지 정하는 RoleBinding, ClusterRoleBinding으로 나뉩니다. ClusterRole을 ClusterRoleBinding으로 연결하면 모든 네임스페이스에 적용되고, RoleBinding으로 연결하면 해당 네임스페이스에만 적용됩니다.

그래서 테넌트용 권한은 ClusterRole `kodeploy-core-tenant`로 정의만 하고 전역으로는 연결하지 않았습니다. 여기에는 Secret 읽기와 쓰기, PVC 생성, Pod 목록 조회, 로그, exec가 들어갑니다. 테넌트 네임스페이스는 앱마다 새로 생기기 때문에 미리 연결해 둘 수 없습니다. 네임스페이스를 만드는 주체가 core이므로, core가 네임스페이스를 만들 때 자신에게 RoleBinding을 겁니다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kodeploy-core
  namespace: app-<hex8>          # 방금 만든 앱 네임스페이스
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kodeploy-core-tenant     # 정의는 클러스터에 하나
subjects:
  - kind: ServiceAccount
    name: kodeploy-core          # core 자신
    namespace: default
```

생성 순서는 네임스페이스, RoleBinding, Secret입니다. 방금 만든 RoleBinding이 API 서버의 권한 판단에 반영되기까지 짧은 지연이 있을 수 있어서, Secret을 만들기 전에 SelfSubjectAccessReview로 이 네임스페이스에 Secret을 만들 수 있는지 확인하고, 허용될 때까지 0.5초 간격으로 최대 15초 기다립니다. 운영에서 임시 네임스페이스로 측정했을 때는 0.07초 만에 반영됐습니다.

```python
review = {
    "apiVersion": "authorization.k8s.io/v1",
    "kind": "SelfSubjectAccessReview",
    "spec": {"resourceAttributes": {
        "namespace": ns, "verb": "create", "resource": "secrets",
    }},
}
while time.time() < deadline:
    res = authz.create_self_subject_access_review(body=review)
    if res.status.allowed:
        return
    time.sleep(0.5)
```

## 그러려면 권한이 더 필요했다

새 네임스페이스에서 core는 아직 아무 권한이 없습니다. 이 상태에서 `kodeploy-core-tenant`를 연결하는 RoleBinding을 만들 수 있는지가 문제였습니다.

RBAC은 권한 상승을 막기 위해, RoleBinding을 만들려면 연결할 롤의 권한을 해당 범위에서 이미 모두 갖고 있거나 그 롤에 대한 `bind` 권한을 갖고 있어야 한다는 규칙을 둡니다. 그래서 core에 다음 전역 권한 세 개가 새로 필요했습니다.

- `namespaces` create: 테넌트 네임스페이스 생성
- `rolebindings` create: 그 안에 RoleBinding 생성
- `clusterroles` bind: `resourceNames`로 `kodeploy-core-tenant` 하나만 허용

세 권한 모두 전역 쓰기 권한입니다. 이대로 두면 core가 탈취됐을 때 kube-system에 RoleBinding을 만들어 `kodeploy-core-tenant`를 자신에게 연결하고, kube-system의 Secret을 읽을 수 있습니다. 결국 처음 문제로 돌아갑니다.

RBAC만으로는 이 권한을 더 좁힐 수 없었습니다.

- `resourceNames`는 정확한 이름만 받기 때문에, `app-`으로 시작하는 이름 같은 조건을 쓸 수 없습니다.
- create 요청에는 `resourceNames`가 적용되지 않습니다. 권한을 판단하는 시점에 새 객체의 이름을 알 수 없는 경우가 있기 때문입니다.
- 테넌트 네임스페이스 안에서만 RoleBinding을 만들 수 있게 하려면 그 네임스페이스에 RoleBinding이 먼저 있어야 해서 순서가 맞지 않습니다.

개수로 보면 전역 권한은 16개에서 8개로 줄었지만, 테넌트용 9개와 빌드 네임스페이스용 6개가 따로 생겨 전체 합은 16개에서 23개로 늘었습니다. 권한이 닿는 범위는 줄었지만 목록은 길어졌고, 새로 생긴 전역 권한은 다른 권한을 부여할 수 있는 권한이었습니다.

## ValidatingAdmissionPolicy로 요청 내용 검사

이 부분은 ValidatingAdmissionPolicy(VAP)로 막았습니다. VAP는 RBAC 검사를 통과한 요청을 저장하기 직전에 요청 내용을 검사해서 거절할 수 있는 정책입니다. K8s 1.30부터 정식 기능이고 CEL 식으로 작성합니다. API 서버 안에서 실행되므로 웹훅 서버를 따로 운영할 필요가 없습니다.

앞에서 admission 정책으로는 Secret 읽기를 막을 수 없다고 했지만, 여기서 막아야 하는 것은 네임스페이스 생성과 RoleBinding 생성이라는 쓰기 요청이고, 쓰기 요청은 admission을 거칩니다. RoleBinding으로 읽기 범위를 좁히고, 그 과정에서 필요해진 쓰기 권한은 VAP로 제한하는 구조입니다.

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

이 정책이 있으면 core가 탈취되더라도 다음 요청은 거절됩니다.

- `argocd-x`, `evil-ns` 같은 이름의 네임스페이스 생성
- kube-system, argocd 같은 네임스페이스에 RoleBinding 생성
- 테넌트 네임스페이스 안에서 테넌트 권한을 다른 계정에 연결하는 RoleBinding 생성

`failurePolicy: Fail`은 CEL 평가 자체가 실패했을 때 요청을 거절하도록 하는 설정입니다. 정책이 오작동하더라도 요청이 허용되는 쪽으로 넘어가지 않게 했습니다.

## nodes/proxy 대신 nodes/stats

관리자 화면의 노드 현황은 노드별 CPU, 메모리, 디스크 사용량을 보여 주기 위해 `nodes/proxy`로 kubelet의 `/stats/summary`를 읽고 있었습니다. 그런데 `nodes/proxy`는 kubelet API 전체에 접근하는 권한이고, kubelet API에는 컨테이너 exec도 포함됩니다. 통계를 읽으려고 모든 노드의 exec 권한까지 갖고 있었습니다.

그래서 API 서버 프록시를 거치지 않고 kubelet의 `/stats/summary`를 직접 호출하도록 바꾸고, 권한은 통계 조회만 가능한 `nodes/stats`만 남겼습니다. kubelet 서빙 인증서는 노드마다 자체 서명 CA로 발급되고 인증서에 적힌 이름도 노드 이름뿐이어서, 각 노드의 CA를 모은 ConfigMap으로 인증서를 검증하고, 접속은 IP로 하되 인증서 확인은 노드 이름으로 하도록 했습니다. 인증서 검증을 끄는 방식은 쓰지 않았습니다.

## 운영 반영 순서

10월 31일에 운영에 반영할 때는 순서가 중요했습니다. 새 core는 테넌트 네임스페이스의 RoleBinding으로 받은 권한으로 동작하는데, 기존 테넌트 네임스페이스 10개에는 이 RoleBinding이 없었습니다. 옛 전역 권한을 먼저 제거하면 그 사이의 배포가 403으로 실패합니다.

1. VAP를 먼저 적용합니다. core가 RoleBinding을 만들 수 있게 되기 전에 제한이 있어야 하기 때문입니다.
2. 옛 권한과 새 권한을 합친 RBAC을 적용합니다.
3. 기존 테넌트 네임스페이스 10개에 RoleBinding을 추가합니다.
4. 새 core를 배포합니다.
5. 옛 전역 권한을 제거한 최종 RBAC을 적용합니다.

검증은 두 가지로 했습니다. 권한은 core 계정으로 위장한 `kubectl auth can-i`로, VAP는 같은 계정으로 위장한 server dry-run으로 확인했습니다. server dry-run은 admission까지 실제로 거치고 저장만 하지 않으므로 운영 환경에서도 정책 동작을 안전하게 확인할 수 있습니다.

```bash
SA=system:serviceaccount:default:kodeploy-core
kubectl auth can-i get secrets -n kube-system --as=$SA   # no
kubectl auth can-i get secrets -n app-<hex8>  --as=$SA   # yes
# 서브리소스는 --subresource로 물어야 맞는 답이 나온다
kubectl auth can-i get nodes --subresource=stats --as=$SA   # yes
# dry-run=server는 admission까지 거치고 저장만 하지 않는다
kubectl create namespace evil-ns --dry-run=server --as=$SA   # VAP가 거절
```

argocd, kube-system, default, monitoring 네임스페이스의 Secret 읽기와 exec는 거부되고 테넌트 네임스페이스에서는 허용되는 것을 확인했습니다. 노드 현황, 로그, 터미널, 환경변수 수정을 실제로 실행해 보고, 임시 네임스페이스를 만들어 core로 삭제해 봤으며, 반영 후 core 로그에서 403은 0건이었습니다.

## 네임스페이스 읽기와 삭제 권한 제거 (11/8)

11월 8일에는 남은 전역 권한 8개 중 네임스페이스 get과 delete를 제거했습니다.

삭제 권한은 테넌트 롤로 옮겼습니다. 네임스페이스 안의 RoleBinding이 주는 `namespaces` 권한은 그 네임스페이스 객체 하나에만 적용됩니다. 네임스페이스 삭제 요청이 해당 네임스페이스 안의 요청으로 판단되기 때문입니다. 따라서 core가 삭제할 수 있는 네임스페이스는 RBAC만으로도 자신의 RoleBinding이 있는 테넌트 네임스페이스로 제한됩니다. VAP의 DELETE 검사는 이중 방어로 남겨 두었습니다.

읽기 권한을 제거하자 두 곳에서 문제가 생겼습니다.

첫째는 앱을 삭제한 직후 다시 배포하는 경우입니다. 앱을 삭제하면 네임스페이스는 한동안 Terminating 상태로 남습니다. 예전에는 네임스페이스를 읽어서 Terminating이 끝날 때까지 기다렸지만, 이제는 읽기 권한이 없습니다. 그래서 생성 요청이 거절되는 것으로 상태를 판단합니다. 네임스페이스 생성은 이미 존재한다는 409로 넘어가고, 그 안에 RoleBinding을 만들 때 `403`이 돌아옵니다. `403`은 권한 거절과 같은 코드이므로, 응답의 `details.causes`에 `NamespaceTerminating`이 있을 때만 삭제 중으로 보고 2초 뒤 처음부터 다시 시도합니다(최대 60초). 네임스페이스가 이미 사라졌다면 `404`가 오고, 다시 시도하면 새 네임스페이스가 만들어집니다.

둘째는 삭제 요청이 `403`을 받는 경우입니다. 삭제 권한이 RoleBinding에서 오기 때문에, RoleBinding이 없는 네임스페이스에 대한 삭제 요청은 `404`가 아니라 `403`을 받습니다. 이미 없는 네임스페이스, 정리가 끝난 Terminating 네임스페이스, 생성 도중 RoleBinding을 만들기 전에 실패한 고아 네임스페이스가 모두 여기에 해당합니다. 그래서 `403`을 받으면 RoleBinding을 다시 만들어 보고, 성공하면 고아 네임스페이스로 보고 다시 삭제하며, 실패하면 삭제할 대상이 없다고 판단합니다.

두 경우 모두 운영과 같은 K8s 1.35 로컬 클러스터에서 core 계정 토큰으로 확인했습니다. 이때 빌드 네임스페이스의 Secret 읽기도 이미지 pull 인증 Secret 하나로 제한했습니다. 전역 권한은 8개에서 6개가 됐고, 삭제 권한이 테넌트 롤로 들어가면서 테넌트용 권한은 9개에서 10개가 됐습니다.

## Pod exec를 게이트웨이로 분리 (11/13)

여기까지 진행해도 테넌트 롤에는 Pod exec가 남아 있었습니다. 웹 터미널, DB 콘솔, 덤프, 복원이 모두 exec를 쓰기 때문입니다. exec 권한은 네임스페이스로 제한해도 그 네임스페이스 안의 모든 Pod에서 임의의 명령을 실행할 수 있습니다. core가 탈취되면 사용자의 DB Pod에 접속해 데이터를 가져갈 수 있습니다. 또 core는 DB 비밀번호를 Secret에서 읽어 명령 인자로 넘기고 있었습니다.

그래서 exec를 core에서 분리했습니다. 테넌트 네임스페이스마다 Go로 만든 작은 게이트웨이(`kodeploy-exec`)를 차트로 배포하고, exec가 필요한 작업을 모두 이 게이트웨이로 옮겼습니다.

- 앱, DB, Redis 터미널: core가 요청한 사용자가 앱 주인인지 확인한 뒤, 서명한 요청으로 게이트웨이에서 30초짜리 1회용 티켓을 받아 브라우저에 전달합니다. 브라우저는 이 티켓으로 게이트웨이에 직접 연결합니다.
- SQL 실행, 테이블 탐색, 덤프, 복원: core가 서명한 요청을 게이트웨이의 내부 엔드포인트로 보냅니다.

게이트웨이 자체에도 제한을 걸었습니다.

- 권한은 자기 네임스페이스의 Pod 목록 조회와 exec뿐이고 Secret 권한은 없습니다. DB 비밀번호는 DB 컨테이너의 환경변수에서 읽기 때문에 명령 인자에서 빠졌습니다.
- 정해진 작업(앱 셸, DB 콘솔, Redis 콘솔, 쿼리, 탐색, 덤프, 복원)만 받고, 임의 명령을 받는 경로는 없습니다.
- 내부 엔드포인트는 NetworkPolicy로 core Pod에서만 접근할 수 있습니다. 같은 네임스페이스의 앱 Pod에서 접속을 시도했을 때 연결되지 않는 것을 확인했습니다.
- 별도의 VAP로 게이트웨이 Pod의 형태를 고정했습니다. 게이트웨이 서비스 계정은 게이트웨이 라벨이 붙은 Pod에서만 쓸 수 있고, 컨테이너는 하나만 허용하며, init 컨테이너와 ephemeral 컨테이너는 금지하고, 이미지는 digest로 고정합니다. 게이트웨이 계정을 쓰는 Pod를 따로 만들어 그 exec 권한을 가로채는 경로를 막기 위해서입니다.

그다음 core의 테넌트 롤에서 `pods/exec`(get, create)를 제거했습니다. 제거 전에는 core 계정의 실제 exec 요청이 허용됐고, 제거 후에는 `403`이 됐습니다. 이 확인을 `can-i` 대신 실제 요청으로 한 이유는, exec 연결은 GET으로 시작하지만 권한은 create로 판정되어 `can-i`의 결과와 실제 판정이 다를 수 있기 때문입니다. get만 남겨 두고 시험했을 때 `can-i`는 허용이라고 답했지만 실제 연결은 `403`이었습니다.

이전 전후로 쿼리와 탐색 결과는 차이가 없었고, 덤프는 바이트 수가 같고 diff도 0이었으며, 복원 후 테이블별 행 수도 같았습니다. 게이트웨이 7개를 상시 실행하는 데 드는 메모리는 합계 61 MiB로, 워커 할당량의 0.35%입니다.

## 결과

지금 core의 권한이 닿는 범위는 다음과 같습니다.

![core 권한이 닿는 범위](/images/posts/rbac-rolebinding-vap/01.png)

| 시점 | 전역 | 테넌트 네임스페이스 | 빌드 네임스페이스 | core 탈취 시 닿는 범위 |
| --- | --- | --- | --- | --- |
| Argo CD 이전 직후 (10/31) | 16 | - | - | 모든 네임스페이스의 Secret, Pod exec, kubelet API |
| RoleBinding + VAP (10/31) | 8 | 9 | 6 | 테넌트 네임스페이스 안의 Secret, Pod exec |
| 네임스페이스 읽기, 삭제 제거 (11/8) | 6 | 10 | 6 | 위와 같음. 네임스페이스 삭제도 자기 것만 가능 |
| exec 게이트웨이 (11/13) | 6 | 8 | 6 | 테넌트 네임스페이스 안의 Secret (Pod exec 없음) |

권한 개수의 합은 16개에서 23개로 늘었다가 20개가 됐습니다. 그 대신 각 권한이 적용되는 범위가 테넌트 네임스페이스와 빌드 네임스페이스로 좁아졌습니다.

남은 전역 권한 6개 중 쓰기 권한 세 개(네임스페이스 생성, RoleBinding 생성, `kodeploy-core-tenant` bind)는 VAP로 제한되고, 나머지 세 개(Pod 목록, 노드 목록, 노드 통계)는 읽기 권한입니다.

## 한계

- core 자체가 탈취되면 게이트웨이를 통한 작업은 여전히 가능합니다. core는 서명 키를 갖고 있으므로 티켓을 받아 셸을 열 수 있습니다. 다만 대상은 해당 테넌트의 앱, DB, Redis로 제한되고, 작업도 정해진 목록 안에서만 가능합니다. core의 토큰만 유출된 경우에는 K8s API로 exec할 권한이 없고 게이트웨이 내부 엔드포인트도 core Pod에서만 접근할 수 있어서 exec가 불가능합니다. 그래서 core가 exec를 전혀 할 수 없다고 말할 수는 없고, 게이트웨이를 거쳐서만 할 수 있다고 보는 것이 정확합니다.
- core는 여전히 테넌트 Secret을 읽고 씁니다. 사용자가 웹에서 환경변수를 수정하면 core가 Secret을 갱신해야 하기 때문입니다. 범위를 테넌트 네임스페이스로 좁혔을 뿐, 테넌트 데이터에 대한 신뢰는 core에 남아 있습니다.
- 전역 쓰기 권한 세 개는 VAP에 의존합니다. 정책이나 바인딩이 삭제되면 다시 열립니다. 이를 삭제할 수 있는 것은 클러스터 관리자뿐입니다.
- 전역 Pod 목록 조회 권한은 남겨 두었습니다. 관리자 화면에서 노드별 Pod 리소스 합계를 보여 주는 데 씁니다. Secret 값은 아니지만 모든 네임스페이스의 Pod 명세(이미지, env에 직접 적힌 값)를 볼 수 있습니다.
- 11/8에 바꾼 Terminating 대기와 고아 네임스페이스 정리 경로는 로컬 클러스터에서만 확인했고, 운영에서 실제로 실행된 것은 아직 확인하지 않았습니다.
- RoleBinding을 거는 작업을 core 밖의 작은 컨트롤러로 옮기면 core에서 RoleBinding 생성 권한과 bind 권한도 뺄 수 있습니다. 대신 컴포넌트가 하나 늘고, 네임스페이스를 만든 뒤 컨트롤러가 RoleBinding을 걸 때까지 기다려야 합니다. 이번에는 VAP로 제한하는 데서 멈췄습니다.
