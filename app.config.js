module.exports = ({ config }) => {
  if (process.env.APP_VARIANT !== 'development') {
    return config;
  }

  return {
    ...config,
    updates: {
      ...config.updates,
      url: 'https://u.expo.dev/6298135d-7aa1-43c0-8b2d-11fd29d572b6',
    },
    runtimeVersion: {
      policy: 'fingerprint',
    },
  };
};
