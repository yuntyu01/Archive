import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
// 한글 바로 옆의 **"강조"**로 같은 굵게가 풀리지 않게 — 기본 CommonMark 규칙은 문장부호+한글 사이의 ** 를 닫지 못한다
import remarkCjkFriendly from "remark-cjk-friendly";
// 따옴표 다듬기만 쓰고 -- → — 변환은 끈다 (주소 속 --까지 —로 바뀌었다). 기본 smartypants는 옵션을 못 받아 직접 붙인다
import remarkSmartypants from "remark-smartypants";

// 마크다운 본문의 "/..." 주소(이미지·글 링크)에 base를 붙인다 - 글에는 /images/…, /blog/…로 쓰고 사이트는 /Archive/ 아래에 뜨므로
const BASE = "/Archive";
function rehypeBase() {
  const fix = (v) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith(BASE + "/") ? BASE + v : v);
  const walk = (node) => {
    if (node.type === "element" && node.properties) {
      if ("src" in node.properties) node.properties.src = fix(node.properties.src);
      if ("href" in node.properties) node.properties.href = fix(node.properties.href);
    }
    (node.children || []).forEach(walk);
  };
  return (tree) => walk(tree);
}

export default defineConfig({
  site: "https://yuntyu01.github.io",
  // 저장소 이름이 Archive라 GitHub Pages 주소가 https://yuntyu01.github.io/Archive/ 다. 코드의 내부 주소는 site.ts의 url()로 만든다
  base: BASE,
  trailingSlash: "always",
  // /posts/는 /blog/로 넘기는 옛 주소라 사이트맵에서 뺀다
  integrations: [sitemap({ filter: (page) => !page.includes("/posts/") })],
  markdown: {
    smartypants: false,
    remarkPlugins: [remarkCjkFriendly, [remarkSmartypants, { dashes: false }]],
    rehypePlugins: [rehypeBase],
    // 코드 색을 라이트/다크 두 벌로 만들고, 어느 쪽을 쓸지는 global.css가 테마에 맞춰 고른다
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false, wrap: false },
  },
});
