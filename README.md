# ARCHIVE

**Live:** https://yuntyu01.github.io/Archive/

ARCHIVE 홈 · 블로그 · 포트폴리오 · 아키텍처 문서를 한 저장소에서 관리합니다. Astro로 빌드해 GitHub Pages에 올립니다 (`main`에 푸시하면 GitHub Actions가 배포).

저장소 이름이 `Archive`라 사이트는 `/Archive/` 아래에 뜹니다 (`astro.config.mjs`의 `base`). 그래서 사이트 안 주소는 코드에서 `"/blog/"`처럼 바로 쓰지 않고 `src/lib/site.ts`의 `url("/blog/")`로 만듭니다. 글(.md) 안의 `/images/…` · `/blog/…`는 빌드할 때 자동으로 `/Archive`가 붙고, `public/` 안의 HTML(포트폴리오 · 아키텍처)은 상대 주소(`../blog/`)를 씁니다.

## 구조

| 경로 | 역할 |
|---|---|
| `src/pages/index.astro` | ARCHIVE 홈 - 연락처(GitHub · LinkedIn · Email) · PROJECTS · PORTFOLIO 버튼 · BLOG(카테고리별) · 오른쪽 목차 |
| `src/lib/site.ts` | 사이트 정보(링크)와 카테고리 계산 |
| `src/pages/blog/` | 글 목록(`/blog/`)과 글 페이지(`/blog/<글 이름>/`) |
| `src/pages/posts/` | 예전 주소(`/posts/`, `/posts/<글 이름>/`)를 `/blog/`로 넘겨주는 리다이렉트 (사이트맵에서는 뺌) |
| `src/content/posts/` | 블로그 글(.md) - 폴더 2단계가 카테고리 2단계 |
| `public/PORTFOLIO/index.html` | 포트폴리오 (`/PORTFOLIO/`). 스타일·스크립트가 다 들어 있는 단일 HTML |
| `public/PORTFOLIO/PORTFOLIO.html` | 예전 주소(`/PORTFOLIO/PORTFOLIO.html`)를 `/PORTFOLIO/`로 넘겨주는 리다이렉트 |
| `public/images/` | 글 이미지(`posts/<글 이름>/`), 목록 썸네일(`thumbs/`), 홈 프로젝트 카드 로고(`logos/`) |
| `public/favicon.png` · `public/apple-touch-icon.png` | ARCHIVE 로고 (브라우저 탭 · 홈 화면 아이콘) |
| `public/architecture/` | KoDeploy 아키텍처 시리즈 (`/architecture/`) - 목차 + 01~06, 다이어그램은 인라인 SVG |
| `figures/kodeploy-architecture.html` | 포트폴리오 아키텍처 그림의 원본 (사이트에 안 올라감). 고친 뒤 스크린샷 → webp → 포트폴리오 img에 base64로 교체 |

## 블로그 글 쓰기

```
src/content/posts/
├── KoDeploy/            ← 큰 카테고리
│   ├── 트러블슈팅/       ← 세부 카테고리
│   │   └── buildkit-dns-timeout.md
│   ├── 성능/
│   ├── 설계/
│   └── 앱 이전/          ← 여기 글은 also로 Dailo에도 보인다
└── Dailo/
    └── 장애 분석/
```

- 폴더를 만들고 `.md`를 넣으면 홈과 `/blog/`의 카테고리에 저절로 나타납니다.
- 글 주소는 폴더와 상관없이 `/blog/<파일 이름>/` - 폴더를 옮겨도 주소가 그대로입니다. 그래서 파일 이름은 겹치면 안 됩니다.
- 큰 카테고리 순서는 `src/lib/site.ts`의 `CATEGORY_ORDER`. 세부 카테고리는 이름순이고, `01-트러블슈팅`처럼 번호를 붙이면 그 순서가 됩니다 (번호는 화면에 안 나옴).
- 머리말: `title`, `date`, `description`, `tags`, `series`, `thumbnail`, `draft`, `also` (`src/content.config.ts` 참고).
- 글의 집은 폴더 하나지만, 머리말에 `also: ["Dailo/앱 이전"]`처럼 "큰/세부"를 적으면 그 카테고리에서도 보입니다 (폴더 이름 그대로).

## 포트폴리오 고치기

`public/PORTFOLIO/index.html`을 직접 고치거나, 사이트의 포트폴리오 화면 오른쪽 위 **수정**으로 고친 뒤 "파일에 바로 저장"(이 파일을 고르면 됨) 또는 "HTML 내려받기"로 받은 파일(이름이 `PORTFOLIO.html`로 받아짐)로 `index.html`을 덮어쓰고 푸시합니다. PDF 저장은 화면의 "PDF 저장".

프로젝트 로고와 아키텍처 그림은 내려받은 HTML에서도 보이도록 `index.html` 안에 base64로 들어 있습니다. 로고 원본은 `public/images/logos/`, 아키텍처 그림 원본은 `figures/kodeploy-architecture.html`입니다.

## 다크 모드

모든 페이지 오른쪽 위 달/해 버튼. 고른 값은 브라우저에 기억되고(홈·블로그·포트폴리오 공유), 고르기 전에는 OS 설정을 따릅니다. 인쇄·PDF는 항상 라이트입니다.

## 로컬에서 보기

```bash
pnpm install
pnpm dev                    # 글·홈 고칠 때 (바로 반영)
pnpm build && pnpm preview  # 배포와 똑같이 보기
```

로컬 주소도 `http://localhost:4321/Archive/`입니다. `pnpm dev`에서는 `/Archive/PORTFOLIO/`처럼 `public/` 안 폴더 주소가 404입니다(`…/PORTFOLIO/index.html`로는 열림). 포트폴리오 · 아키텍처까지 확인하려면 build 후 preview로 봅니다.
