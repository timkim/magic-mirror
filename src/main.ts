import './ui/styles.css';
import { App } from './app';
import { coreFeatures } from './features';
import { viewportFeature } from './features/viewport';
import { compareFeature } from './features/compare';
import { sceneInfoFeature } from './features/sceneInfo';
import { environmentFeature } from './features/environment';
import { timelineFeature } from './features/timeline';
import { farmFeature } from './features/farm';

// Order matters only for toolbar and panel placement.
const features = [...coreFeatures, sceneInfoFeature, viewportFeature, environmentFeature, compareFeature, timelineFeature, farmFeature];

const root = document.getElementById('app')!;
App.create(root, features)
  .then((app) => Object.assign(window, { app })) // handy for poking at it in the console
  .catch((e: Error) => {
    root.innerHTML = `<div class="mm-error"><h1>Magic Mirror can't start</h1><p>${e.message}</p></div>`;
  });
