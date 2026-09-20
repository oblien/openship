import { replace } from 'react-router';

export function clientLoader() {
  throw replace('/mail/inbox');
}
