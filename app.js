
/* =========================================================
   データはサーバー（data/albums.json, data/site.json）から取得します。
   追加・編集・削除は /admin から行ってください。
   ========================================================= */
const grid = document.getElementById("grid");
const tagsNav = document.getElementById("tags");
const sortsNav = document.getElementById("sorts");
const dialog = document.getElementById("detail");
const sheet = document.getElementById("sheet");

/* 並び順。manual は albums.json の並び（編集画面でドラッグして決めた順）そのまま */
const ORDERS = {
  manual: { label: "ならべた順", compare: null },
  newest: { label: "新しい順", compare: (a, b) => String(b.date).localeCompare(String(a.date)) },
  oldest: { label: "古い順", compare: (a, b) => String(a.date).localeCompare(String(b.date)) },
  title:  { label: "タイトル順", compare: (a, b) => String(a.title).localeCompare(String(b.title), "ja") },
};
const ORDER_KEY = "photo-note-order";

let albums = [];
let site = {};
let activeTag = null;
let order = "manual";
let sourceWrap = null;

/* 表示オプション（site.json に無い＝古い設定のときは表示する） */
const showDate = () => site.showDate !== false;
const showTags = () => site.showTags !== false;
const showPin = () => site.showPin !== false;

const fmtDate = (iso) => String(iso).replaceAll("-", ".");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* カードの中はタグが増えると縦に伸びるので、上限を超えた分は「+N」にまとめる */
const CARD_TAG_LIMIT = 3;
const tagHtml = (tags, limit) => {
  const list = tags || [];
  const shown = limit ? list.slice(0, limit) : list;
  const rest = list.length - shown.length;
  return shown.map(t => `<span>#${esc(t)}</span>`).join("") +
    (rest > 0 ? `<span class="rest" title="${esc(list.slice(limit).map(t => "#" + t).join(" "))}">+${rest}</span>` : "");
};

/* ---------- 起動時のスプラッシュ ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 画像が出るまで待つ。遅いときは limit で打ち切る */
function waitImage(img, limit) {
  if (!img.getAttribute("src")) return Promise.resolve();
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise(done => {
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
    setTimeout(done, limit);
  });
}

function endSplash() {
  document.getElementById("splash")?.remove();
  document.body.classList.remove("is-splashing");
}

async function runSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const box = document.getElementById("splash-avatar");
  const img = document.getElementById("splash-img");
  const target = document.querySelector("header .avatar");

  // 動きを控える設定なら演出しない
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return endSplash();

  if (!site.avatar) {          // アイコンなしの設定なら地が消えるだけ
    box.remove();
    splash.classList.add("is-done");
    await sleep(1850);
    return endSplash();
  }

  img.src = site.avatar;
  box.classList.add("is-waiting");
  await waitImage(img, 2500);
  box.classList.remove("is-waiting");
  await sleep(700);            // 真ん中のアイコンを少し見せる

  // いまの位置からヘッダーの定位置へ（FLIP）
  const from = box.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  box.classList.add("is-moving");
  box.style.transform =
    `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})`;
  splash.classList.add("is-done");   // 地はフェードしながら消える

  await sleep(1850);                 // 移動 1.7s / 地のフェード 0.2s + 1.6s
  endSplash();
}

/* head の meta を差し替える（無ければ作る） */
function setMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!content) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/* ---------- 読み込み中の見た目 ---------- */
const SK_RATIOS = ["4 / 3", "3 / 4", "1 / 1", "4 / 5", "3 / 2", "5 / 6"];

function renderSkeleton(n = 6) {
  const cols = columnCount();
  const buckets = Array.from({ length: cols }, () => []);
  for (let i = 0; i < n; i++) buckets[i % cols].push(i);
  grid.innerHTML = buckets.map(b => `
    <div class="grid-col">
      ${b.map(i => `
        <div class="card-wrap">
          <div class="skeleton">
            <div class="sk-thumb" style="aspect-ratio:${SK_RATIOS[i % SK_RATIOS.length]}"></div>
            <div class="sk-line"></div>
            <div class="sk-line short"></div>
          </div>
        </div>`).join("")}
    </div>`).join("");
}

/* 写真は読み込めたものからフェードインさせる（load はバブルしないので捕捉フェーズで拾う） */
grid.addEventListener("load", e => {
  if (e.target.classList?.contains("thumb")) e.target.classList.add("is-loaded");
}, true);

function revealLoadedThumbs() {
  // キャッシュ済みの画像は load が飛ばないことがある
  grid.querySelectorAll(".thumb").forEach(img => {
    if (img.complete && img.naturalWidth) img.classList.add("is-loaded");
  });
}

/* ---------- 読み込み ---------- */
async function load() {
  const [siteData, list] = await Promise.all([
    fetch("./data/site.json").then(r => r.json()),
    fetch("./data/albums.json").then(r => r.json())
  ]);
  site = siteData || {};
  albums = Array.isArray(list) ? list : [];

  document.title = site.title || "しゃしんのノート";
  // 書き出したものには build.js が静的に入れる。ここは編集中の確認用
  setMeta("name", "description", site.description || site.subtitle || "");
  document.getElementById("site-title").textContent = site.title || "";
  document.getElementById("site-sub").textContent = site.subtitle || "";
  document.getElementById("ribbon").textContent = site.ribbon || "";
  document.getElementById("site-footer").textContent = site.footer || "";
  // 最終更新日。まだ一度も保存していなければ何も出さない
  document.getElementById("site-updated").textContent =
    (site.showUpdated !== false && site.updatedAt)
      ? "最終更新 " + fmtDate(site.updatedAt.slice(0, 10))
      : "";
  document.body.classList.remove("is-loading");
  const avatar = document.getElementById("avatar");
  avatar.closest(".avatar").classList.remove("is-loading");
  if (site.avatar) avatar.src = site.avatar; else avatar.closest(".avatar").style.display = "none";

  // 既定の並び順。見る人が前回えらんだものがあればそちらを優先する
  order = ORDERS[site.defaultOrder] ? site.defaultOrder : "manual";
  if (site.showSort !== false) {
    try {
      const saved = localStorage.getItem(ORDER_KEY);
      if (saved && ORDERS[saved]) order = saved;
    } catch { /* プライベートウィンドウなどでは無視 */ }
  }

  renderTags();
  renderSorts();
  renderGrid();
  // Web フォントが遅れて効くとタグの行数が変わるので、読み込み後にもう一度数える
  document.fonts?.ready.then(updateTagsMore).catch(() => {});

  setupBgVideo();
  setupMiniAvatar();

  await runSplash();   // アイコンが定位置に着いてから中身を触らせる
  if (location.hash) openAlbum(decodeURIComponent(location.hash.slice(1)));
}

/* ---------- 描画 ---------- */
let hiddenTagCount = 0;

function renderTags() {
  const more = document.getElementById("tags-more");
  if (!showTags()) {           // タグを出さない設定なら絞り込みも隠す
    tagsNav.innerHTML = "";
    more.hidden = true;
    activeTag = null;
    return;
  }
  const all = [...new Set(albums.flatMap(a => a.tags || []))].sort((a, b) => a.localeCompare(b, "ja"));
  tagsNav.innerHTML =
    `<button class="tag ${activeTag ? "" : "is-active"}" data-tag="">すべて</button>` +
    all.map(t => `<button class="tag ${activeTag === t ? "is-active" : ""}" data-tag="${esc(t)}">#${esc(t)}</button>`).join("");
  updateTagsMore();
}

/* 2 行に収まらないタグが何個あるか数えて「ほか N 件」を出す */
function updateTagsMore() {
  const more = document.getElementById("tags-more");
  const wasExpanded = tagsNav.classList.contains("is-expanded");
  tagsNav.classList.remove("is-expanded");

  const tops = [...tagsNav.children].map(el => el.offsetTop);
  const rows = [...new Set(tops)].sort((a, b) => a - b);
  const firstTwo = rows.slice(0, 2);
  hiddenTagCount = tops.filter(t => !firstTwo.includes(t)).length;

  more.hidden = hiddenTagCount === 0;
  if (wasExpanded && hiddenTagCount) tagsNav.classList.add("is-expanded");
  more.textContent = tagsNav.classList.contains("is-expanded")
    ? "タグをとじる"
    : `ほか ${hiddenTagCount} 件のタグ`;
}

function renderSorts() {
  if (site.showSort === false) {   // 見る人には出さない設定
    sortsNav.innerHTML = "";
    return;
  }
  sortsNav.innerHTML =
    `<span class="sort-label">並び順</span>` +
    Object.entries(ORDERS).map(([key, o]) =>
      `<button class="sort ${order === key ? "is-active" : ""}" data-order="${key}">${o.label}</button>`
    ).join("");
}

/* 絞り込みと並び替えを適用したアルバム */
function visibleAlbums() {
  const list = albums.filter(a => !activeTag || (a.tags || []).includes(activeTag));
  const compare = ORDERS[order]?.compare;
  const sorted = compare ? list.sort(compare) : list;
  // ピン留めはどの並び順でも先頭へ。sort は安定なので、
  // ピン留めどうし・それ以外どうしの順番はいま決まった並びのまま。
  return sorted.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/* 画面幅から列数を出す（元の column-width: 280px 相当） */
const MIN_COL = 280;
const COL_GAP = 22;
function columnCount() {
  const inner = grid.clientWidth - 40; // 左右の padding ぶん
  return Math.max(1, Math.floor((inner + COL_GAP) / (MIN_COL + COL_GAP)));
}

function cardHtml(a, seq) {
  const visuals = (a.items || []).filter(i => i.type === "photo" || i.type === "video").length;
  const stack = Math.min(visuals, 3);
  // 表紙が無く、動画だけのアルバムはカードに印を出す
  const videoOnly = !a.cover && (a.items || []).some(i => i.type === "video");
  // 少しずつ遅らせて順に出す。枚数が多くても待たせないよう頭打ちにする
  const delay = Math.min(seq * 35, 320);
  const pin = showPin() && a.pinned;   // 📌 はピン留めしたものだけ
  return `
    <div class="card-wrap is-entering${a.pinned ? " is-pinned" : ""}" data-stack="${stack}" style="animation-delay:${delay}ms">
      <button class="card" type="button" data-id="${esc(a.id)}">
        <img class="thumb" src="${esc(a.cover || "")}" alt="" loading="lazy">
        ${videoOnly ? `<span class="thumb-none">▶</span>` : ""}
        <div class="card-body">
          <h2>${esc(a.title)}</h2>
          ${showTags() && (a.tags || []).length ? `<div class="card-tags">${tagHtml(a.tags, CARD_TAG_LIMIT)}</div>` : ""}
        </div>
        ${pin || showDate() ? `
        <div class="card-foot">
          <span class="pin">${pin ? "📌" : ""}</span>
          ${showDate() ? `<time datetime="${esc(a.date)}">${fmtDate(a.date)}</time>` : ""}
        </div>` : ""}
      </button>
    </div>`;
}

let lastCols = 0;

function renderGrid() {
  const list = visibleAlbums();
  if (!list.length) {
    lastCols = 0;
    grid.innerHTML = `<p class="empty">${activeTag ? "このタグの写真はまだありません。" : "まだ何もありません。"}</p>`;
    return;
  }
  // i 番目を i 列目に置くと、横に読んだとき 1,2,3… の順になる
  const cols = columnCount();
  lastCols = cols;
  const buckets = Array.from({ length: cols }, () => []);
  list.forEach((a, i) => buckets[i % cols].push({ album: a, seq: i }));
  grid.innerHTML = buckets
    .map(b => `<div class="grid-col">${b.map(x => cardHtml(x.album, x.seq)).join("")}</div>`)
    .join("");
  revealLoadedThumbs();
}

/* 本文の 1 要素（写真 / 動画 / 文章）を組み立てる */
function itemHtml(item) {
  if (item.type === "photo") {
    return `
      <figure class="photo">
        <img src="${esc(item.src)}" alt="${esc(item.alt || "")}" loading="lazy">
        ${item.caption ? `<figcaption>${esc(item.caption)}</figcaption>` : ""}
      </figure>`;
  }
  if (item.type === "video") {
    // 自動再生はしない（通信量と音が邪魔になるため）。ループ指定のものだけ
    // 音を切って自動で回す。
    const auto = item.loop ? " autoplay muted loop" : "";
    return `
      <figure class="photo video">
        <video src="${esc(item.src)}" ${item.poster ? `poster="${esc(item.poster)}"` : ""}
               controls playsinline preload="metadata"${auto}></video>
        ${item.caption ? `<figcaption>${esc(item.caption)}</figcaption>` : ""}
      </figure>`;
  }
  return `<p class="text">${esc(item.body)}</p>`;
}

function buildSheet(a, ratio) {
  sheet.innerHTML = `
    <img class="cover" src="${esc(a.cover || "")}" alt="" style="${ratio ? `aspect-ratio:${ratio}` : ""}">
    <div class="body">
      <div class="head">
        <h1 id="detail-title">${esc(a.title)}</h1>
        ${showDate() ? `<time datetime="${esc(a.date)}">${fmtDate(a.date)}</time>` : ""}
      </div>
      ${(a.items || []).map(itemHtml).join("")}
      ${(showPin() && a.pinned) || (showTags() && (a.tags || []).length) ? `
      <div class="foot">
        <span class="pin">${showPin() && a.pinned ? "📌" : ""}</span>
        ${showTags() ? `<div class="card-tags">${tagHtml(a.tags)}</div>` : ""}
      </div>` : ""}
    </div>`;
}

/* カードの位置・サイズから、開いたシートの位置へ変形する (FLIP) */
function flipFrom(fromRect) {
  const to = sheet.getBoundingClientRect();
  const sx = fromRect.width / to.width;
  const sy = fromRect.height / to.height;
  const dx = fromRect.left - to.left;
  const dy = fromRect.top - to.top;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

/* 開き終わったときの後始末（何度呼ばれても同じ結果になるようにしておく） */
function finishOpen() {
  sheet.classList.add("is-ready");
  sheet.classList.remove("is-animating");      // 合成レイヤーを持ち続けない
  document.body.classList.add("is-bg-hidden"); // 背後の描画を止める
}

function openAlbum(id, fromCard) {
  const a = albums.find(x => x.id === id);
  if (!a) return;
  const thumb = fromCard?.querySelector(".thumb");
  const ratio = thumb?.naturalWidth ? `${thumb.naturalWidth} / ${thumb.naturalHeight}` : "";
  buildSheet(a, ratio);
  document.body.classList.add("is-locked");
  dialog.classList.add("is-open");
  dialog.scrollTop = 0;
  sheet.classList.remove("is-ready", "is-animating");

  if (fromCard) {
    sourceWrap = fromCard.closest(".card-wrap");
    const rect = fromCard.getBoundingClientRect();
    // カードの位置から始めて、シートの位置へ戻す（FLIP）。
    // requestAnimationFrame は裏タブだと発火しないので、
    // 強制リフローで開始位置を確定させてから同期的に戻す。
    sheet.style.transition = "none";
    sheet.style.transform = flipFrom(rect);
    sheet.getBoundingClientRect(); // ここで開始位置を確定
    sourceWrap.classList.add("is-source");
    sheet.style.transition = "";
    sheet.classList.add("is-animating");
    sheet.style.transform = "none";
    sheet.addEventListener("transitionend", finishOpen, { once: true });
    // transitionend が来ない場合の保険。来ないままだと本文が高さ 0 のまま。
    setTimeout(finishOpen, 300);
  } else {
    sheet.style.transform = "none";
    finishOpen();
  }
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  document.getElementById("close").focus({ preventScroll: true });
}

function closeAlbum() {
  history.replaceState(null, "", location.pathname);
  const done = () => {
    dialog.classList.remove("is-open");
    document.body.classList.remove("is-locked", "is-bg-hidden");
    sourceWrap?.classList.remove("is-source");
    sourceWrap = null;
    sheet.classList.remove("is-animating");
    sheet.style.transform = "none";
  };
  sheet.classList.remove("is-ready");
  // 縮んでいく先が見えるよう、背後を先に戻す（is-locked は最後まで維持して
  // スクロールバーの出入りによるレイアウトのずれを防ぐ）
  document.body.classList.remove("is-bg-hidden");
  const card = sourceWrap?.querySelector(".card");
  if (card && dialog.scrollTop < 120) {
    sheet.classList.add("is-animating");
    sheet.style.transform = flipFrom(card.getBoundingClientRect());
    sheet.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 350); // 念のため
  } else {
    done();
  }
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && dialog.classList.contains("is-open")) closeAlbum();
});

tagsNav.addEventListener("click", e => {
  const b = e.target.closest(".tag");
  if (!b) return;
  activeTag = b.dataset.tag || null;
  renderTags();
  renderGrid();
});

document.getElementById("tags-more").addEventListener("click", e => {
  const open = tagsNav.classList.toggle("is-expanded");
  e.currentTarget.textContent = open ? "タグをとじる" : `ほか ${hiddenTagCount} 件のタグ`;
});

/* 幅が変わって列数が変わったときだけ組み直す（詳細を開いている間は触らない） */
window.addEventListener("resize", () => {
  if (dialog.classList.contains("is-open")) return;
  if (columnCount() !== lastCols) renderGrid();
  updateTagsMore();
});
sortsNav.addEventListener("click", e => {
  const b = e.target.closest(".sort");
  if (!b) return;
  order = b.dataset.order;
  try { localStorage.setItem(ORDER_KEY, order); } catch { /* 保存できなくても動く */ }
  renderSorts();
  renderGrid();
});
grid.addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (card) openAlbum(card.dataset.id, card);
});
document.getElementById("close").addEventListener("click", closeAlbum);
dialog.addEventListener("click", e => { if (e.target === dialog) closeAlbum(); });

/* ---------- たまに背景を横切る動画 ----------
   透過 WebM を、間を空けて一度ずつ流す。装飾なので、
   再生できない相手（Safari など）では何も起きないだけにしておく。 */
function setupBgVideo() {
  const el = document.getElementById("bg-video");
  if (!el || !site.bgVideo) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!el.canPlayType("video/webm")) return;

  el.src = site.bgVideo;
  const every = Math.max(10, Number(site.bgEvery) || 60) * 1000;
  let timer = null;   // 次に出す予約。手で流したときは取り消す

  const playOnce = async () => {
    // 見ていないタブでは流さない。詳細を開いている間も邪魔しない
    if (document.visibilityState !== "visible" || dialog.classList.contains("is-open")) {
      schedule();
      return;
    }
    try {
      el.currentTime = 0;
      await el.play();
      el.classList.add("is-on");
    } catch {
      return;   // 自動再生を止められている。あきらめる
    }
  };

  const schedule = () => {
    // 毎回ちょうど同じ間隔だと仕掛けが見えるので、前後にばらつかせる
    clearTimeout(timer);
    timer = setTimeout(playOnce, every * (0.7 + Math.random() * 0.6));
  };

  el.addEventListener("ended", () => {
    el.classList.remove("is-on");
    schedule();
  });
  el.addEventListener("error", () => { el.classList.remove("is-on"); });

  schedule();

  /* --- 開発者ツールから触るための入口 ---
     bg.play()      いますぐ流す
     bg.drop("8%")  通る高さを変える（小さいほど上）
     bg.at(6)       その秒数で止めて位置を見る
     bg.info()      いまの状態 */
  window.bg = {
    play() {
      clearTimeout(timer);   // 予約と重ならないように
      el.currentTime = 0;
      el.classList.add("is-on");
      // 裏タブや自動再生の制限で断られることがある。投げっぱなしにしない
      return el.play().then(() => "流しています").catch((e) => {
        el.classList.remove("is-on");
        return "流せませんでした: " + e.message;
      });
    },
    stop() {
      clearTimeout(timer);
      el.pause();
      el.classList.remove("is-on");
    },
    next() {                 // 予約を入れ直す（間隔の確認用）
      schedule();
      return "次の 1 回を予約しました";
    },
    drop(v) {
      if (v == null) return getComputedStyle(el).getPropertyValue("--bg-video-drop").trim();
      el.style.setProperty("--bg-video-drop", v);
      return v;
    },
    size(v) {   // 画面幅に対する %。100 で画面いっぱい
      if (v == null) return getComputedStyle(el).getPropertyValue("--bg-video-size").trim();
      el.style.setProperty("--bg-video-size", String(v));
      return v;
    },
    at(t) {
      el.classList.add("is-on");
      el.pause();
      el.currentTime = t;
      return t;
    },
    info() {
      const r = el.getBoundingClientRect();
      return {
        src: el.getAttribute("src"),
        再生中: !el.paused,
        位置: el.currentTime.toFixed(1) + " / " + (el.duration || 0).toFixed(1) + "s",
        通る高さ: this.drop(),
        大きさ: this.size() + "%（画面幅に対して）",
        出る間隔: (Number(site.bgEvery) || 60) + "s（前後にばらつきます）",
        動画の枠: Math.round(r.width) + "x" + Math.round(r.height) + " top=" + Math.round(r.top),
      };
    },
  };
}

/* ---------- 上に居座る小さいアイコン ----------
   ヘッダーのアイコンが上の縁飾りの裏に隠れたら出す。押すと先頭にもどる。 */
function setupMiniAvatar() {
  const mini = document.getElementById("mini-avatar");
  const box = document.querySelector("header .avatar");
  if (!mini || !box || !site.avatar) return;

  document.getElementById("mini-avatar-img").src = site.avatar;
  mini.hidden = false;

  // 判定の境目は縁飾りの下端。帯に隠れた時点で「見えなくなった」とみなす。
  // IntersectionObserver は裏のタブだと更新が止まることがあるので、
  // スクロールのたびに自分で測る（getBoundingClientRect は十分に速い）。
  const edge = document.querySelector(".fluff-top");
  const update = () => {
    const cover = edge ? edge.getBoundingClientRect().height : 0;
    mini.classList.toggle("is-on", box.getBoundingClientRect().bottom <= cover);
  };
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  // 交差の監視も併せて掛けておく。どちらか動くほうで切り替われば良い
  if (window.IntersectionObserver) {
    const cover = edge ? Math.round(edge.getBoundingClientRect().height) : 0;
    new IntersectionObserver(update, { rootMargin: `-${cover}px 0px 0px 0px` }).observe(box);
  }
  update();

  mini.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

/* ---------- アイコンを押したときの遊び ----------
   押すたびにぷるっと震えて、5 回で一回転する。気づいた人だけのもの。 */
function setupAvatarTaps() {
  const box = document.querySelector("header .avatar");
  if (!box) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let taps = 0;
  let forget = null;

  // 同じアニメーションを続けて出せるよう、クラスを外して入れ直す
  const play = (cls, ms) => {
    box.classList.remove(cls);
    void box.offsetWidth;
    box.classList.add(cls);
    setTimeout(() => box.classList.remove(cls), ms);
  };

  const sparkle = () => {
    const r = box.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < 10; i++) {
      const dot = document.createElement("span");
      dot.className = "sparkle";
      const angle = (Math.PI * 2 * i) / 10 + Math.random() * 0.5;
      const dist = 48 + Math.random() * 26;
      dot.style.left = cx + "px";
      dot.style.top = cy + "px";
      dot.style.setProperty("--dx", Math.cos(angle) * dist + "px");
      dot.style.setProperty("--dy", Math.sin(angle) * dist + "px");
      document.body.appendChild(dot);
      dot.addEventListener("animationend", () => dot.remove(), { once: true });
    }
  };

  box.addEventListener("click", () => {
    if (document.body.classList.contains("is-splashing")) return;
    taps++;
    clearTimeout(forget);
    forget = setTimeout(() => { taps = 0; }, 1600);   // 間が空いたら数え直し
    if (taps >= 5) {
      taps = 0;
      play("is-spinning", 750);
      sparkle();
    } else {
      play("is-wobbling", 300);
    }
  });
}

document.getElementById("year").textContent = new Date().getFullYear();
setupAvatarTaps();
renderSkeleton();   // データが届くまでの間
load().catch(err => {
  endSplash();   // 失敗してもスプラッシュは残さない
  document.body.classList.remove("is-loading");
  grid.innerHTML = `<p class="empty">データを読み込めませんでした。<br>${esc(err.message)}</p>`;
});
