function roundedRemaining(quota) {
  if (!quota || !Number.isFinite(Number(quota.remainingPercent))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(quota.remainingPercent))));
}

export function formatTrayTitle(quotas = []) {
  const fiveHour = quotas.find((quota) => Number(quota.windowMinutes) === 300);
  const sevenDay = quotas.find((quota) => Number(quota.windowMinutes) === 10080);
  const fiveHourRemaining = roundedRemaining(fiveHour);
  const sevenDayRemaining = roundedRemaining(sevenDay);

  if (fiveHourRemaining !== null && sevenDayRemaining !== null) {
    return `5h ${fiveHourRemaining}% · 7d ${sevenDayRemaining}%`;
  }
  if (fiveHourRemaining !== null) return `5h ${fiveHourRemaining}%`;
  if (sevenDayRemaining !== null) return `7d ${sevenDayRemaining}%`;

  const firstAvailable = quotas.find(
    (quota) => roundedRemaining(quota) !== null
  );
  const remaining = roundedRemaining(firstAvailable);
  return remaining === null ? "余量 —" : `余量 ${remaining}%`;
}
