import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// 用 astro/loaders 的 glob 显式指定 base，等价于 Starlight 的 docsLoader()
// （docsLoader 内部即 glob({base: getCollectionPathFromRoot('docs', config)})）。
// 显式 base 跨环境（本地 Node 24 / CI Node 20）行为一致，避免 docsLoader
// 在含非 ASCII 路径下的 base 解析问题。schema 仍用 Starlight 的 docsSchema()。
const docs = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/docs' }),
  schema: docsSchema(),
});

export const collections = { docs };
