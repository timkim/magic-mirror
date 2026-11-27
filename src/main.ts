import './app.css';
import { mount } from 'svelte';
import { App } from './app';
import AppView from './ui/App.svelte';
import { coreFeatures } from './features';
import { viewportFeature } from './features/viewport';
import { compareFeature } from './features/compare';
import { sceneInfoFeature } from './features/sceneInfo';
import { environmentFeature } from './features/environment';
import { timelineFeature } from './features/timeline';
import { farmFeature } from './features/farm';
import { editorFeature } from './features/editor';

// Order matters only where features share a slot and order value.
const features = [...coreFeatures, sceneInfoFeature, viewportFeature, environmentFeature, compareFeature, timelineFeature, farmFeature, editorFeature];

const root = document.getElementById('app')!;
App.create(features)
  .then((app) => {
    Object.assign(window, { app }); // handy for poking at it in the console
    mount(AppView, { target: root, props: { app } });
  })
  .catch((e: Error) => {
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'p-10 max-w-xl text-foreground';
    const h = document.createElement('h1');
    h.className = 'text-xl font-semibold mb-2';
    h.textContent = "Magic Mirror can't start";
    const p = document.createElement('p');
    p.className = 'text-muted-foreground';
    p.textContent = e.message;
    box.append(h, p);
    root.append(box);
  });
