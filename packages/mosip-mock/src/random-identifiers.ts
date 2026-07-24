export const createNid = async () => {
  const prefixes = ["CM", "CF"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];

  const digits = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 10)
  ).join("");

  return prefix + digits;
};