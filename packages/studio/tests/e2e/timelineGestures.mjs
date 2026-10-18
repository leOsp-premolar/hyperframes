/**
 * Hover a timeline clip's end edge until its trim handle mounts, and return the press point.
 * The handle only renders on hover, so a press before it mounts would start a move instead.
 */
export async function hoverClipEndEdge(page, clipSelector, box) {
  const edgeX = box.x + box.width - 3;
  const midY = box.y + box.height / 2;
  await page.mouse.move(edgeX - 20, midY);
  await page.mouse.move(edgeX, midY);
  await page.waitForFunction(
    (sel) =>
      [...document.querySelectorAll(`${sel} div`)].some((d) => d.style.cursor === "col-resize"),
    { timeout: 10_000 },
    clipSelector,
  );
  return { edgeX, midY };
}

/** The timeline clip whose element id is `id`. */
export function clipSelector(id) {
  return `.timeline-clip[data-el-id$="#${id}"]`;
}

export function clipBox(page, id) {
  return page.$eval(clipSelector(id), (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** Press at (x, y) and drag by (dx, dy) in four steps. */
export async function dragFrom(page, x, y, dx, dy = 0) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const part of [0.25, 0.5, 0.75, 1]) await page.mouse.move(x + dx * part, y + dy * part);
  await page.mouse.up();
}

/** Press the middle of a clip, away from its trim handles, and drag. */
export async function dragClipBody(page, id, dx, dy = 0) {
  const box = await clipBox(page, id);
  await dragFrom(page, box.x + box.width / 2, box.y + box.height / 2, dx, dy);
}
