// Baked-in demo manifest so the static Vercel build can render and play
// the showcase video without needing a reachable backend. Mirrors
// server/demo-videos.json — keep them in sync if you add more entries.
const DEMO_VIDEOS = [
  {
    id: 'house_of_dragon_05.mp4',
    name: 'house_of_dragon_05',
    filename: 'house_of_dragon_05.mp4',
    url: 'https://pub-df2ec71b6f1b4b8b9493812724efeed0.r2.dev/uploads/house_of_dragon_05.mp4',
    size: 453650565,
    uploadedAt: '2026-04-30T00:00:00.000Z',
  },
];

export default DEMO_VIDEOS;
