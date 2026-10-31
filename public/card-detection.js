// Shared by the classic vision worker and numerical image-processing tests.
self.detectCardCorners = function (
  cv,
  rgba,
  width,
  height,
  face,
  report = () => {},
) {
  if (!face?.[234] || !face?.[454]) return null;
  const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
  const gray = new cv.Mat(),
    edges = new cv.Mat();
  const contours = new cv.MatVector(),
    hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const candidates = [];
  let issue = "not-found",
    issueArea = 0;
  const rejected = (reason, area) => {
    if (area > issueArea) {
      issue = reason;
      issueArea = area;
    }
  };
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    for (const [low, high] of [
      [45, 110],
      [15, 45],
    ]) {
      cv.Canny(gray, edges, low, high);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
      cv.findContours(
        edges,
        contours,
        hierarchy,
        cv.RETR_LIST,
        cv.CHAIN_APPROX_NONE,
      );
      const fx = face[1].x * width,
        fy = face[1].y * height;
      const fw = Math.abs(face[234].x - face[454].x) * width;
      for (let i = 0; i < Math.min(contours.size(), 2000); i++) {
        const contour = contours.get(i),
          approx = new cv.Mat();
        try {
          const area = Math.abs(cv.contourArea(contour));
          if (area < 400 || area > width * height * 0.25) continue;
          cv.approxPolyDP(
            contour,
            approx,
            cv.arcLength(contour, true) * 0.025,
            true,
          );
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
          let points = Array.from({ length: 4 }, (_, j) => ({
            x: approx.data32S[j * 2],
            y: approx.data32S[j * 2 + 1],
          }));
          const center = {
            x: points.reduce((s, p) => s + p.x, 0) / 4,
            y: points.reduce((s, p) => s + p.y, 0) / 4,
          };
          if (
            Math.abs(center.x - fx) < fw * 0.5 ||
            Math.abs(center.x - fx) > fw * 3 ||
            Math.abs(center.y - fy) > fw * 1.5
          ) {
            rejected("beside-face", area);
            continue;
          }
          points.sort(
            (a, b) =>
              Math.atan2(a.y - center.y, a.x - center.x) -
              Math.atan2(b.y - center.y, b.x - center.x),
          );
          let first = 0;
          for (let j = 1; j < 4; j++)
            if (points[j].x + points[j].y < points[first].x + points[first].y)
              first = j;
          points = [...points.slice(first), ...points.slice(0, first)];
          const lengths = points.map((p, j) =>
            distance(p, points[(j + 1) % 4]),
          );
          if (Math.min(...lengths) < 18) {
            rejected("small", area);
            continue;
          }
          if (
            points.some(
              (p) => p.x < 6 || p.y < 6 || p.x > width - 6 || p.y > height - 6,
            )
          ) {
            rejected("clipped", area);
            continue;
          }
          const ratio = (lengths[0] + lengths[2]) / (lengths[1] + lengths[3]);
          if (ratio < 1 || ratio > 2.6) {
            rejected("landscape", area);
            continue;
          }
          // Fit the straight interior of each edge, then intersect adjacent lines.
          // The card's rounded corners are excluded from the fits.
          const lines = points.map((p, j) => {
            const q = points[(j + 1) % 4],
              dx = q.x - p.x,
              dy = q.y - p.y;
            const length = Math.hypot(dx, dy),
              samples = [];
            for (let k = 0; k < contour.rows; k++) {
              const x = contour.data32S[k * 2],
                y = contour.data32S[k * 2 + 1];
              const t = ((x - p.x) * dx + (y - p.y) * dy) / length ** 2;
              if (
                t > 0.18 &&
                t < 0.82 &&
                Math.abs((x - p.x) * dy - (y - p.y) * dx) / length < 3
              )
                samples.push({ x, y });
            }
            if (samples.length < 10) return null;
            const mx = samples.reduce((s, v) => s + v.x, 0) / samples.length;
            const my = samples.reduce((s, v) => s + v.y, 0) / samples.length;
            const xx = samples.reduce((s, v) => s + (v.x - mx) ** 2, 0);
            const yy = samples.reduce((s, v) => s + (v.y - my) ** 2, 0);
            const xy = samples.reduce((s, v) => s + (v.x - mx) * (v.y - my), 0);
            const angle = Math.atan2(2 * xy, xx - yy) / 2;
            const a = -Math.sin(angle),
              b = Math.cos(angle);
            return { a, b, c: a * mx + b * my };
          });
          if (lines.some((l) => !l)) {
            rejected("edges", area);
            continue;
          }
          const refined = lines.map((line, j) => {
            const previous = lines[(j + 3) % 4];
            const determinant = previous.a * line.b - line.a * previous.b;
            return {
              x: (previous.c * line.b - line.c * previous.b) / determinant,
              y: (previous.a * line.c - line.a * previous.c) / determinant,
            };
          });
          if (
            refined.some(
              (p, j) =>
                !Number.isFinite(p.x) ||
                !Number.isFinite(p.y) ||
                distance(p, points[j]) > 9,
            )
          ) {
            rejected("edges", area);
            continue;
          }
          candidates.push({ corners: refined, area, center });
        } finally {
          contour.delete();
          approx.delete();
        }
      }
      if (candidates.length) break;
    }
    candidates.sort((a, b) => b.area - a.area);
    const best = candidates[0];
    if (!best) {
      report(issue);
      return null;
    }
    if (
      candidates.some(
        (c) =>
          c !== best &&
          c.area > best.area * 0.65 &&
          distance(c.center, best.center) > 25,
      )
    ) {
      report("ambiguous");
      return null;
    }
    report(null);
    return best.corners;
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
};
