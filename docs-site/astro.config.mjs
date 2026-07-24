// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages 部署在 smith-106.github.io/niko-hub，故 base 为 /niko-hub/
export default defineConfig({
  site: 'https://smith-106.github.io',
  base: '/niko-hub/',
  integrations: [
    starlight({
      title: 'niko-hub',
      // 中文优先（守 ui-conventions 桌面优先中文优先基线）
      defaultLocale: 'zh',
      social: {
        github: 'https://github.com/Smith-106/niko-hub',
      },
      sidebar: [
        {
          label: '开始',
          items: [
            { label: '首页', link: '/' },
            { label: '下载安装', link: '/download/' },
            { label: '快速开始', link: '/quickstart/' },
          ],
        },
        {
          label: '功能',
          items: [
            { label: '记忆系统', link: '/features/memory/' },
            { label: '角色灵魂', link: '/features/character-soul/' },
            { label: '拆书库', link: '/features/book-analysis/' },
            { label: '审查系统', link: '/features/review/' },
            { label: '连续性引擎', link: '/features/continuity-engine/' },
            { label: '图谱', link: '/features/graph/' },
          ],
        },
        {
          label: '开发者',
          items: [
            { label: '架构概览', link: '/dev/architecture/' },
            { label: '核心概念', link: '/dev/concepts/' },
            { label: '本地构建', link: '/dev/build/' },
          ],
        },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
