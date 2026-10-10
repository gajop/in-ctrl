// Finding comments on a long page: a rail on the right edge with a mark for
// each comment thread (where it sits on the page), and ▲/▼ buttons that jump
// to the nearest thread above or below, with how many there are each way.
// Replies to read (an agent wrote last) are orange, the rest blue.

/** Threads with comments, and folded files that hide some. */
const TARGETS = "main .thread:has(.card.comment), main .folded-comments";

export function installCommentMinimap() {
  const rail = document.createElement("div");
  rail.className = "comment-rail";
  const nav = document.createElement("div");
  nav.className = "comment-jump";
  nav.innerHTML = `<button type="button" class="up" title="Previous comment">▲ <span></span></button><button type="button" class="down" title="Next comment">▼ <span></span></button>`;
  document.body.append(rail, nav);

  const targets = () => [...document.querySelectorAll<HTMLElement>(TARGETS)].filter((el) => el.offsetParent !== null);
  const pageY = (el: HTMLElement) => el.getBoundingClientRect().top + window.scrollY;
  const lastComment = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".card.comment")].at(-1);
  const isReply = (el: HTMLElement) => lastComment(el)?.classList.contains("from-agent") ?? false;

  const jump = (el: HTMLElement) => {
    if (el.matches(".folded-comments")) return el.click();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  };

  let frame = 0;
  const draw = () => {
    frame = 0;
    const list = targets();
    rail.hidden = nav.hidden = !list.length;
    if (!list.length) return;
    const height = document.documentElement.scrollHeight;
    rail.replaceChildren(
      ...list.map((el) => {
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = `rail-mark${isReply(el) ? " reply" : ""}${el.matches(".folded-comments") ? " folded" : ""}`;
        mark.style.top = `${(pageY(el) / height) * 100}%`;
        mark.title = el.matches(".folded-comments") ? "Comments in a folded file" : (lastComment(el)?.querySelector(".card-body")?.textContent ?? "").slice(0, 80);
        mark.addEventListener("click", () => jump(el));
        return mark;
      }),
    );
    const view = document.createElement("div");
    view.className = "rail-view";
    view.style.top = `${(window.scrollY / height) * 100}%`;
    view.style.height = `${(window.innerHeight / height) * 100}%`;
    rail.append(view);
    const top = window.scrollY + 80;
    const bottom = window.scrollY + window.innerHeight - 80;
    const above = list.filter((el) => pageY(el) + el.offsetHeight < top);
    const below = list.filter((el) => pageY(el) > bottom);
    const [up, down] = nav.querySelectorAll<HTMLButtonElement>("button");
    up.querySelector("span")!.textContent = String(above.length);
    down.querySelector("span")!.textContent = String(below.length);
    up.disabled = !above.length;
    down.disabled = !below.length;
    up.onclick = () => above.at(-1) && jump(above.at(-1)!);
    down.onclick = () => below[0] && jump(below[0]);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  document.addEventListener("guide:page", schedule);
  // Redraw when the page changes, but not for the rail's own updates.
  new MutationObserver((records) => {
    if (records.some((r) => !rail.contains(r.target) && !nav.contains(r.target))) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  schedule();
}
