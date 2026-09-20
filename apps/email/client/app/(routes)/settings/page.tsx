import { replace } from 'react-router';

export function clientLoader() {
  throw replace('/settings/general');
}
