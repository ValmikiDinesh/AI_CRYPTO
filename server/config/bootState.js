let isSystemWarmingUp = true;

export const setSystemWarmingUp = (status) => {
  isSystemWarmingUp = status;
};

export const getSystemWarmingUp = () => {
  return isSystemWarmingUp;
};
