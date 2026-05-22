// 整集讨论区 —— 预先编写的高拟真社区评论（前端种子，无后端）。
// 按 videoId 组织；故意不按点赞数排好序，好让前端的「热度排序」肉眼可见地生效。
// 内容覆盖剧情解读 / 理论考据 / 吐槽三类，长短不一（长的用来演示折叠/展开）。

const DISCUSSION_SEED = {
  house_of_dragon_05: [
    {
      comment_id: 'hod05_d1',
      author: '高庭情报站',
      time: '3d',
      upvotes: 1243,
      text: '绿裙那一幕封神——Alicent 故意迟到、穿一身高庭战时召集色登场，这是她第一次当众向 Rhaenyra 宣战。全场只有 Rhaenyra 一个人当场听懂了，那个对视太狠了。',
    },
    {
      comment_id: 'hod05_d2',
      author: '绿党黑党都站',
      time: '2d',
      upvotes: 892,
      text: 'Criston 当众打死 Joffrey 不是单纯失控，是他意识到自己的秘密被对方捏在手里。从这一刻起他彻底倒向绿党，骑士的体面被他自己踩碎在婚礼地板上。',
    },
    {
      comment_id: 'hod05_d3',
      author: '红色婚礼幸存者',
      time: '1d',
      upvotes: 567,
      text: '这集婚礼死人比红色婚礼还突然，HBO 你能不能让人喘口气再发刀。',
    },
    {
      comment_id: 'hod05_d4',
      author: 'Daemon辩护律师',
      time: '2d',
      upvotes: 734,
      text: 'Daemon 杀妻那段镜头给得极克制——没拍过程，只拍结果。剧组故意让你既怀疑又拿不到实锤，而这种「可否认性」恰恰是 Daemon 这个角色的核心：他做尽脏事，却永远不留把柄。后面他对 Rhaenyra 说「你该自己去拿你想要的」，根就扎在这里。',
    },
    {
      comment_id: 'hod05_d5',
      author: '铁王座骨科',
      time: '18h',
      upvotes: 445,
      text: '注意 Viserys 这集咳血越来越频繁，铁王座割的伤口一直不愈合——马丁在用国王身体的腐烂，隐喻整个王国的腐烂。',
    },
    {
      comment_id: 'hod05_d6',
      author: '意难平专业户',
      time: '20h',
      upvotes: 389,
      text: 'Laenor 和 Joffrey 才是这集唯一的真爱，结果编剧开场没多久就给我刀了。',
    },
    {
      comment_id: 'hod05_d7',
      author: '箴言考据组',
      time: '1d',
      upvotes: 612,
      text: '这集标题「We Light the Way」就是 Hightower 家族的箴言——标题本身在剧透：这是 Hightower（绿党）正式登场掌权的一集。',
    },
    {
      comment_id: 'hod05_d8',
      author: '鸭鹅之约见证人',
      time: '15h',
      upvotes: 521,
      text: 'Rhaenyra 和 Laenor 婚前那段「鸭鹅之约」其实是全集最成熟的一段关系——两个被政治联姻摆布的年轻人，坦诚谈好「对外完婚、对内各自自由」。可惜 Criston 听不懂这套新规则，他要的是非黑即白的爱情或荣誉，悲剧由此开始。',
    },
    {
      comment_id: 'hod05_d9',
      author: 'Otto的头发',
      time: '12h',
      upvotes: 278,
      text: 'Otto 被撤了首相还阴魂不散，这老狐狸的政治生命力比龙还顽强。',
    },
    {
      comment_id: 'hod05_d10',
      author: '维斯特洛时事评论',
      time: '1d',
      upvotes: 701,
      text: '这集是全剧第一个真正的转折点：婚礼前大家还坐在同一张牌桌上，婚礼后绿黑彻底分裂。一场婚礼硬生生办成了开战仪式。',
    },
    {
      comment_id: 'hod05_d11',
      author: '配乐课代表',
      time: '8h',
      upvotes: 334,
      text: '小细节：绿裙登场时 Ramin Djawadi 把主题旋律改成了小调，配乐提前告诉你「气氛变了」。',
    },
    {
      comment_id: 'hod05_d12',
      author: '婚礼策划黑名单',
      time: '6h',
      upvotes: 256,
      text: '看完这集最大的感受：在维斯特洛参加婚礼，一定要先买好保险。',
    },
  ],
};

export default DISCUSSION_SEED;
