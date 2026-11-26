// App shell: toolbar, two docked side columns, the viewport stage and a status bar.
// Features add their own toolbar items, panels and status fields through this API.

export type PanelSlot = 'left' | 'right';

export interface PanelHandle {
  root: HTMLElement;
  body: HTMLElement;
  setTitle(t: string): void;
}

export class Layout {
  readonly toolbar: HTMLElement;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  readonly viewport: HTMLElement;
  /** Holds the canvas and overlays; sized to the render's aspect ratio. */
  readonly stage: HTMLElement;
  readonly status: HTMLElement;
  /** Strip under the viewport for the animation timeline (hidden until used). */
  readonly timeline: HTMLElement;
  private statusFields = new Map<string, HTMLElement>();

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <header class="mm-toolbar"><div class="mm-brand">Magic Mirror</div></header>
      <aside class="mm-col mm-left"></aside>
      <main class="mm-viewport"><div class="mm-stage"></div></main>
      <aside class="mm-col mm-right"></aside>
      <div class="mm-timeline" hidden></div>
      <footer class="mm-status"></footer>`;
    root.classList.add('mm-app');
    this.toolbar = root.querySelector('.mm-toolbar')!;
    this.left = root.querySelector('.mm-left')!;
    this.right = root.querySelector('.mm-right')!;
    this.viewport = root.querySelector('.mm-viewport')!;
    this.stage = root.querySelector('.mm-stage')!;
    this.status = root.querySelector('.mm-status')!;
    this.timeline = root.querySelector('.mm-timeline')!;
  }

  addPanel(slot: PanelSlot, title: string, opts: { collapsed?: boolean; order?: number } = {}): PanelHandle {
    const root = document.createElement('section');
    root.className = 'mm-panel';
    if (opts.collapsed) root.classList.add('collapsed');
    root.style.order = String(opts.order ?? 0);
    const head = document.createElement('h2');
    head.textContent = title;
    head.addEventListener('click', () => root.classList.toggle('collapsed'));
    const body = document.createElement('div');
    body.className = 'mm-panel-body';
    root.append(head, body);
    (slot === 'left' ? this.left : this.right).append(root);
    return { root, body, setTitle: (t) => (head.textContent = t) };
  }

  addButton(label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    this.toolbar.append(b);
    return b;
  }

  addToolbarElement(el: HTMLElement) {
    this.toolbar.append(el);
  }

  setStatus(id: string, text: string) {
    let el = this.statusFields.get(id);
    if (!el) {
      el = document.createElement('span');
      this.statusFields.set(id, el);
      this.status.append(el);
    }
    el.textContent = text;
  }

  /** Fit the stage inside the viewport at the given aspect ratio. */
  fitStage(width: number, height: number) {
    const vw = this.viewport.clientWidth - 24, vh = this.viewport.clientHeight - 24;
    const k = Math.min(vw / width, vh / height);
    this.stage.style.width = `${Math.floor(width * k)}px`;
    this.stage.style.height = `${Math.floor(height * k)}px`;
  }
}
