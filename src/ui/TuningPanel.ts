/**
 * DEVELOPMENT TUNING: a nested details element inside Options, created only in
 * development builds. Plain numeric inputs, one atomic apply, in-memory only.
 */
import type { VehicleTuning } from '../config';
import { TUNE_FIELDS, parseTune, tuneDisplay, type TuneKey, type TunePatch } from '../physics/VehicleTune';

export class TuningPanel {
  private readonly inputs: Array<[TuneKey, HTMLInputElement]> = [];
  private readonly status: HTMLElement;

  constructor(page: Document, parent: HTMLElement, tuning: VehicleTuning, onApply: (patch: TunePatch) => void, onRestore: () => void) {
    const root = page.createElement('details');
    const summary = page.createElement('summary');
    summary.textContent = 'DEVELOPMENT TUNING';
    const fields = page.createElement('div');
    fields.className = 'tuning__fields';
    const note = page.createElement('p');
    note.className = 'options__note';
    note.textContent = 'Practice tuning; Time Attack restores stock.';
    fields.append(note);
    for (const [key, label, unit, min, max] of TUNE_FIELDS) {
      const field = page.createElement('label');
      const input = page.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.inputMode = 'decimal';
      field.append(`${label} (${unit}, ${key.startsWith('gear') ? `above ${min}, below ${max}` : `${min} to ${max}`})`, input);
      fields.append(field);
      this.inputs.push([key, input]);
    }
    this.status = page.createElement('p');
    this.status.className = 'options__note';
    this.status.setAttribute('role', 'status');
    const button = (text: string, onClick: () => void): HTMLButtonElement => {
      const node = page.createElement('button');
      node.type = 'button';
      node.textContent = text;
      node.addEventListener('click', onClick);
      return node;
    };
    fields.append(
      this.status,
      button('APPLY & RESET PRACTICE', () => {
        const raw: Record<string, string> = {};
        for (const [key, input] of this.inputs) raw[key] = input.value;
        const result = parseTune(raw, tuning);
        if (!result.ok) { this.status.textContent = result.error; return; }
        onApply(result.patch);
        this.refresh(tuning);
        this.status.textContent = 'Applied. Practice reset.';
      }),
      button('RESTORE STOCK', () => {
        onRestore();
        this.refresh(tuning);
        this.status.textContent = 'Stock restored. Practice reset.';
      }),
    );
    root.append(summary, fields);
    parent.append(root);
    this.refresh(tuning);
  }

  /** Shows the given tuning in the inputs and clears the status line. */
  refresh(tuning: VehicleTuning): void {
    const values = tuneDisplay(tuning);
    for (const [key, input] of this.inputs) input.value = String(values[key]);
    this.status.textContent = '';
  }
}
