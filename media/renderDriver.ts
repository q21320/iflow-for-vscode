import { performFullRender, type FullRenderOptions } from './renderCoordinator';

export interface WebviewRenderDriver {
  renderFull(options: FullRenderOptions): void;
}

class StringTemplateRenderDriver implements WebviewRenderDriver {
  renderFull(options: FullRenderOptions): void {
    performFullRender(options);
  }
}

export function createStringTemplateRenderDriver(): WebviewRenderDriver {
  return new StringTemplateRenderDriver();
}
