// Adding credentials cannot enable an integration that has not been implemented.
// Replace this boundary only after OAuth, account binding and the GPU probe exist.
export function getKaggleAvailability() {
  return {
    available: false,
    message: 'Online GPU setup is not available yet. You can still upload files and manage your queue.',
  };
}
