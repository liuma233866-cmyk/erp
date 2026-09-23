function parseYandexDateTime(dateValue, timeValue = "") {
  if (!dateValue) return "";
  const text = String(dateValue).trim();
  const dateTimeMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!dateTimeMatch) {
    // Yandex order endpoints commonly return ISO-8601 strings; fall back to
    // generic parsing instead of returning "" (which callers replace with
    // "now", silently corrupting order timestamps).
    return parseGenericDateTime(text);
  }
  const day = Number(dateTimeMatch[1]);
  const month = Number(dateTimeMatch[2]);
  const year = Number(dateTimeMatch[3]);
  let hour = Number(dateTimeMatch[4] || "0");
  let minute = Number(dateTimeMatch[5] || "0");
  let second = Number(dateTimeMatch[6] || "0");
  if (timeValue && !dateTimeMatch[4]) {
    const timeMatch = String(timeValue).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (timeMatch) {
      hour = Number(timeMatch[1]);
      minute = Number(timeMatch[2]);
      second = Number(timeMatch[3] || "0");
    }
  }
  // Yandex returns Moscow time (UTC+3) without zone info. Construct in UTC and
  // subtract 3 hours so the result does not depend on the server's local zone.
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 3 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function parseGenericDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
}

function parseDateTimeMaybe(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const yandexParsed = parseYandexDateTime(raw);
  if (yandexParsed) return yandexParsed;

  return parseGenericDateTime(raw);
}

function formatYandexDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

function formatYandexBusinessDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${year}-${month}-${day}`;
}

function normalizeYandexBusinessDateInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split("-");
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatYandexBusinessDate(parsed);
}

function buildYandexOrderDateRanges(lookbackDays = 180, chunkDays = 29) {
  const safeLookbackDays = Math.max(29, Number(lookbackDays || 0) || 29);
  const safeChunkDays = Math.max(1, Math.min(29, Number(chunkDays || 0) || 29));
  const now = new Date();
  const ranges = [];
  let end = new Date(now);

  while (ranges.length < 100) {
    const start = new Date(end);
    start.setDate(start.getDate() - safeChunkDays);
    ranges.push({
      fromDate: formatYandexDate(start),
      toDate: formatYandexDate(end)
    });
    if (ranges.length * safeChunkDays >= safeLookbackDays) break;
    end = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  }

  return ranges;
}

function normalizeYandexDateInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split("-");
    return `${day}-${month}-${year}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatYandexDate(parsed);
}

function buildYandexOrderDateRangesFromWindow(fromDate, toDate, chunkDays = 29) {
  const from = parseDateTimeMaybe(fromDate);
  const to = parseDateTimeMaybe(toDate);
  if (!from || !to) return [];
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const safeChunkDays = Math.max(1, Math.min(29, Number(chunkDays || 0) || 29));
  const ranges = [];
  let cursor = new Date(start);

  while (cursor <= end && ranges.length < 100) {
    const rangeEnd = new Date(cursor);
    rangeEnd.setDate(rangeEnd.getDate() + safeChunkDays);
    if (rangeEnd > end) rangeEnd.setTime(end.getTime());
    ranges.push({
      fromDate: formatYandexDate(cursor),
      toDate: formatYandexDate(rangeEnd)
    });
    const next = new Date(rangeEnd);
    next.setDate(next.getDate() + 1);
    cursor = next;
  }

  return ranges;
}

function addDaysToYandexDate(value, days = 1) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = parseDateTimeMaybe(raw);
  if (!date) return "";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  parsed.setDate(parsed.getDate() + Number(days || 0));
  return formatYandexDate(parsed);
}

module.exports = {
  addDaysToYandexDate,
  buildYandexOrderDateRanges,
  buildYandexOrderDateRangesFromWindow,
  formatYandexBusinessDate,
  formatYandexDate,
  normalizeYandexBusinessDateInput,
  normalizeYandexDateInput,
  parseDateTimeMaybe,
  parseGenericDateTime,
  parseYandexDateTime
};
