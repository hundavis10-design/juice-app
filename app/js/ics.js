// .ics calendar file for a planned drive (RFC 5545). Times in UTC.

function esc(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function utc(d) {
  return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Fold lines longer than 75 octets (UTF-8 aware, never splitting a character). */
export function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "", size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { out.push(cur); cur = ""; size = 0; limit = 74; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/**
 * { id, summary, start: Date, minutes, location, url, description, alarmLead: minutes|null, now }
 * The event lasts max(15, minutes ?? 60) minutes, like the app.
 */
export function buildICS({ id, summary, start, minutes, location, url, description, alarmLead = null, now = new Date() }) {
  const s = new Date(start);
  const e = new Date(s.getTime() + Math.max(15, minutes ?? 60) * 60000);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JUICE//JUICE for the web//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${id}@juice-web`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(s)}`,
    `DTEND:${utc(e)}`,
    `SUMMARY:${esc(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${esc(location)}`);
  if (url) lines.push(`URL:${url}`);
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  if (alarmLead) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(summary)}`, `TRIGGER:-PT${Math.round(alarmLead)}M`, "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
