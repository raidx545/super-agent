// ============================================================
// VLESS — Action History
// Undo/Redo capability with full state snapshots
// Every action is recorded so you can step back in time
// ============================================================

import type { AgentAction, ActionResult, PageState } from "../../types";

// ── History Entry ────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  timestamp: number;
  action: AgentAction;
  result: ActionResult;
  pageStateBefore: PageState;
  pageStateAfter: PageState;
  reasoning: string;
}

// ── History State ────────────────────────────────────────────

class ActionHistory {
  private entries: HistoryEntry[] = [];
  private currentIndex: number = -1;
  private maxSize: number = 100;

  /**
   * Record a new action (clears any redo history).
   */
  record(entry: Omit<HistoryEntry, "id" | "timestamp">): HistoryEntry {
    const fullEntry: HistoryEntry = {
      ...entry,
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };

    // Clear any entries after current position (redo history)
    if (this.currentIndex < this.entries.length - 1) {
      this.entries = this.entries.slice(0, this.currentIndex + 1);
    }

    this.entries.push(fullEntry);

    // Enforce max size
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    } else {
      this.currentIndex++;
    }

    return fullEntry;
  }

  /**
   * Undo the last action (returns the entry to undo).
   */
  undo(): HistoryEntry | null {
    if (this.currentIndex < 0) return null;

    const entry = this.entries[this.currentIndex];
    this.currentIndex--;
    return entry;
  }

  /**
   * Redo a previously undone action.
   */
  redo(): HistoryEntry | null {
    if (this.currentIndex >= this.entries.length - 1) return null;

    this.currentIndex++;
    return this.entries[this.currentIndex];
  }

  /**
   * Undo to a specific point in history.
   */
  undoTo(entryId: string): HistoryEntry[] {
    const targetIndex = this.entries.findIndex((e) => e.id === entryId);
    if (targetIndex === -1) return [];

    const undone: HistoryEntry[] = [];
    while (this.currentIndex > targetIndex) {
      const entry = this.entries[this.currentIndex];
      this.currentIndex--;
      undone.push(entry);
    }

    return undone;
  }

  /**
   * Get all entries.
   */
  getAll(): HistoryEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries between two indices.
   */
  getRange(from: number, to: number): HistoryEntry[] {
    return this.entries.slice(from, to + 1);
  }

  /**
   * Get the current entry.
   */
  getCurrent(): HistoryEntry | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.entries.length) {
      return null;
    }
    return this.entries[this.currentIndex];
  }

  /**
   * Can we undo?
   */
  canUndo(): boolean {
    return this.currentIndex >= 0;
  }

  /**
   * Can we redo?
   */
  canRedo(): boolean {
    return this.currentIndex < this.entries.length - 1;
  }

  /**
   * Get current position in history.
   */
  getPosition(): { current: number; total: number } {
    return {
      current: this.currentIndex + 1,
      total: this.entries.length,
    };
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.entries = [];
    this.currentIndex = -1;
  }

  /**
   * Get summary statistics.
   */
  getStats(): {
    total: number;
    successful: number;
    failed: number;
    averageTime: number;
  } {
    const successful = this.entries.filter((e) => e.result.success).length;
    const failed = this.entries.length - successful;
    const avgTime =
      this.entries.length > 0
        ? this.entries.reduce((sum, e) => sum + e.result.executionTime, 0) /
          this.entries.length
        : 0;

    return {
      total: this.entries.length,
      successful,
      failed,
      averageTime: avgTime,
    };
  }
}

// ── Singleton ────────────────────────────────────────────────

export const actionHistory = new ActionHistory();
