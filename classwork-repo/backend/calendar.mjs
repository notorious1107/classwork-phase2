// The application's Beijing calendar uses UTC+08:00, independent of the host timezone.
export const beijingDateKey = value => new Date(Date.parse(value) + 8 * 60 * 60_000).toISOString().slice(0, 10);

export function calendarMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1) {
    throw Object.assign(new Error('月份请使用有效的 YYYY-MM 格式'), { status: 400 });
  }
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  const days = Array.from({ length: last.getUTCDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  return { start: `${month}-01T00:00:00+08:00`, days };
}
