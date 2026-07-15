// Baked-in demo manifest so the static Vercel build can render and play
// the showcase video without needing a reachable backend. Mirrors
// server/demo-videos.json — keep them in sync if you add more entries.
//
// URL is built from REACT_APP_VIDEO_CDN at build time. Falling back to
// the Cloudflare-managed `*.r2.dev` host is convenient for dev but is
// often DNS-blocked from mainland China — point REACT_APP_VIDEO_CDN at
// a custom domain bound to the R2 bucket for a stable experience.
const VIDEO_CDN =
  process.env.REACT_APP_VIDEO_CDN ||
  'https://pub-df2ec71b6f1b4b8b9493812724efeed0.r2.dev';

const DEMO_VIDEOS = [
  {
    id: 'house_of_dragon_05.mp4',
    name: '龙之家族',
    filename: 'house_of_dragon_05.mp4',
    url: `${VIDEO_CDN}/uploads/house_of_dragon_05.mp4`,
    size: 311015435,
    uploadedAt: '2026-04-30T00:00:00.000Z',
  },
  {
    id: 'house_of_dragon_s03e01.mp4',
    name: '龙之家族',
    filename: 'house_of_dragon_s03e01.mp4',
    url: `${VIDEO_CDN}/uploads/house_of_dragon_s03e01.mp4`,
    size: 422973034,
    uploadedAt: '2026-07-14T07:56:33.000Z',
    season: 3,
    episode: 1,
    episodeTag: 'S03E01',
    episodeTitle: '盐与海，火与血',
  },
];

export default DEMO_VIDEOS;
