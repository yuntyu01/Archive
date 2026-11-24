# 시연 영상 녹화

`app.kodeploy.com`에서 실제로 배포 한 번을 해서 30초 안팎 시연 영상을 만든다. 결과는 `public/capstone/demo.mp4`로 저장되고, 발표 페이지 5번 슬라이드가 그 파일을 자동 재생한다.

## 준비

- Node 18 이상, ffmpeg
- 이 폴더에서 `npm install` 다음 `npx playwright install chromium`

## 순서

```bash
node record.mjs login    # 처음 한 번: 열린 브라우저에서 GitHub로 로그인하고 창을 닫는다
node record.mjs record   # 시나리오대로 클릭하며 녹화 (빌드를 기다리느라 몇 분 걸림)
node record.mjs edit     # 빌드 구간만 빨리 감아 30초 안팎으로 → public/capstone/demo.mp4
```

`node record.mjs all`은 record와 edit를 이어서 한다.

브라우저를 1280×720 화면에 1.5배율로 띄우고, 배율이 반영된 1920×1080 스크린샷을 초당 20장 가까이 찍어 영상으로 잇는다. 화면 속 글씨가 150% 크기로 선명하게 찍힌다. (Playwright 내장 녹화는 배율을 무시하고 작게 찍혀서 쓰지 않는다.) 빌드를 기다리는 동안은 1.5초에 한 장만 찍는다. 폼 입력과 접속·DB 장면은 정상 속도라 완성 영상은 30초 남짓이 된다.

## 시나리오

1. 배포 폼에 저장소 링크 입력, 브랜치 선택 → 다음
2. 앱 이름, 런타임(Java), 데이터베이스(MySQL 8.4) → 다음 → 배포 시작
3. 진행 화면에서 "앱이 준비됐어요"까지 기다린다. 이 구간은 편집에서 빨리 감고, 녹화 중 화면 왼쪽 아래에 "빌드 구간 빨리 감기" 표시를 띄운다
4. `https://<앱 이름>.kodeploy.com`을 연다. 영상에는 주소창이 안 찍혀서 주소 띠를 화면 위에 얹는다
5. 작업 공간의 데이터베이스 터미널에서 `SHOW TABLES;` (Spring 앱이 만든 테이블이 보인다)

영상에는 마우스 커서가 안 찍히므로 스크립트가 커서와 클릭 표시를 화면에 그린다.

## 바꿀 수 있는 값

| 변수 | 기본값 |
|---|---|
| `KD_REPO` | `https://github.com/yuntyu01/kodeploy-test-spring` |
| `KD_BRANCH` | `master` |
| `KD_APP_NAME` | `capstone-demo` (소문자·숫자·하이픈, 이미 있는 앱 이름이면 실패) |
| `KD_DB` | `MySQL 8.4` |
| `KD_SQL` | `SHOW TABLES;` |
| `KD_TARGET` | `30` (완성 영상 목표 길이, 초) |
| `KD_OUT` | `../../public/capstone/demo.mp4` |
| `KD_BASE` | `https://app.kodeploy.com` |
| `KD_W`, `KD_H` | `1280`, `720` (작을수록 글씨가 크게 찍힌다) |
| `KD_SCALE` | `1.5` (W×H×배율이 실제 녹화 픽셀) |
| `KD_APP_URL` | `https://<앱 이름>.kodeploy.com` |

다시 찍을 때는 앞서 만든 데모 앱을 지우거나 `KD_APP_NAME`을 바꾼다.

## 막힐 때

- 중간에 멈추면 `out/error.png`에 그 순간 화면이 남는다.
- 버튼이나 입력칸을 못 찾으면 배포 화면 코드(kodeploy 저장소 `web/src/components/deploy/steps/`)의 id와 버튼 문구를 확인한다. 스크립트는 `#wz-repo` `#wz-branch` `#wz-name` `#wz-runtime` `#wz-db`와 버튼 "다음: 실행 환경" "다음: 최종 확인" "배포 시작", 상태 문구 "앱이 준비됐어요"를 쓴다.
- 영상은 libx264(CRF 16)로 저장하고, ffmpeg에 libx264가 없으면 libopenh264를 10Mbps로 쓴다. 둘 다 없으면 libx264가 들어 있는 ffmpeg를 설치한다.
- 녹화한 프레임(`out/frames`)이 남아 있으면 `edit`만 다시 돌려 길이(`KD_TARGET`)를 바꿀 수 있다.

`profile/`에는 로그인 상태가 들어 있으니 커밋하지 않는다 (`.gitignore`에 있음).
