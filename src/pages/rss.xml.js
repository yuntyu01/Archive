import rss from "@astrojs/rss";
import { allPosts, SITE, url } from "../lib/site";

export async function GET(context) {
  const posts = await allPosts();
  return rss({
    title: `${SITE.name} 블로그`,
    description: SITE.description,
    site: new URL(import.meta.env.BASE_URL, context.site).href, // 채널 주소도 /Archive/ 아래
    items: posts.map((p) => ({
      title: p.data.title,
      pubDate: p.data.date,
      description: p.data.description,
      link: url(`/blog/${p.id}/`),
    })),
  });
}
