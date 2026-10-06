/**
 * OpenCoach UI kit v1 (browser entry). Loaded by views as:
 *   <link rel="stylesheet" href="/kit/1/kit.css">
 *   <script type="module" src="/kit/1/kit.js"></script>
 * It installs `window.coach`, applies the theme and defines the <rc-*> custom elements.
 * View scripts must be external module scripts (the CSP forbids inline scripts).
 */
import { createCoach, KIT_MAJOR, type Coach } from './coach';
import { h, s } from './util';
import { registerBasic, iconNames } from './components/basic';
import { setCoach } from './components/base';
import { registerBodyMap } from './components/body-map';
import { registerCalendar } from './components/calendar';
import { registerChart } from './components/chart';
import { registerData } from './components/data';
import { registerForm } from './components/form';
import { registerWorkout } from './components/workout-el';

declare global {
  interface Window {
    coach: Coach;
  }
}

function boot(): Coach {
  const existing = (window as { coach?: Coach }).coach;
  if (existing) return existing;
  const coach = createCoach({ win: window });
  window.coach = coach;
  setCoach(coach);
  registerBasic();
  registerData();
  registerCalendar();
  registerChart();
  registerWorkout();
  registerBodyMap();
  registerForm();
  return coach;
}

export const coach = boot();
export const kit = { major: KIT_MAJOR, icons: iconNames };
/** DOM helpers for view scripts: h('div', { class: 'x' }, 'text', child) builds elements without innerHTML. */
export { h, s };
export const format = coach.format;
export const dates = coach.dates;
