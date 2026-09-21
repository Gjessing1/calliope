import type { JSX } from 'react';
import type { LibraryView } from '../library-view.js';
interface ToolbarProps {
  search: string;
  view: LibraryView;
  scanning: boolean;
  scanLabel: string;
  selecting: boolean;
  onSelecting: (on: boolean) => void;
  /** Books whose file and Audiobookshelf disagree; 0 hides the filter. */
  driftCount: number;
  driftOnly: boolean;
  onDriftOnly: (on: boolean) => void;
  /** Books with at least one file-derived health issue. */
  healthCount: number;
  healthOnly: boolean;
  onHealthOnly: (on: boolean) => void;
  onSearch: (value: string) => void;
  onView: (value: LibraryView) => void;
  onScan: () => void | Promise<void>;
}

export function Toolbar({
  search,
  view,
  scanning,
  scanLabel,
  selecting,
  onSelecting,
  driftCount,
  driftOnly,
  onDriftOnly,
  healthCount,
  healthOnly,
  onHealthOnly,
  onSearch,
  onView,
  onScan,
}: ToolbarProps): JSX.Element {
  return (
    <div className="toolbar">
      <input
        className="search"
        type="search"
        value={search}
        placeholder="Search title, author, series…"
        onChange={(e) => onSearch(e.target.value)}
        aria-label="Search the library"
      />
      <select
        value={view}
        onChange={(event) => onView(event.target.value as LibraryView)}
        aria-label="Library view"
      >
        <option value="title">Titles</option>
        <option value="author">Authors</option>
        <option value="series">Series</option>
        <option value="added">Recently added</option>
        <option value="modified">Recently modified</option>
      </select>
      {(driftCount > 0 || driftOnly) && (
        <button
          type="button"
          className={driftOnly ? 'filter on' : 'filter'}
          aria-pressed={driftOnly}
          aria-label={`Differs from Audiobookshelf: ${driftCount} books`}
          onClick={() => onDriftOnly(!driftOnly)}
          title="Show only books whose file says something different from Audiobookshelf"
        >
          Differs<span className="full"> from Audiobookshelf</span>
          <span className="filter-count">{driftCount}</span>
        </button>
      )}
      {(healthCount > 0 || healthOnly) && (
        <button
          type="button"
          className={healthOnly ? 'filter on' : 'filter'}
          aria-pressed={healthOnly}
          aria-label={`Needs attention: ${healthCount} books`}
          onClick={() => onHealthOnly(!healthOnly)}
          title="Show only books with missing or suspicious file metadata"
        >
          Needs attention
          <span className="filter-count">{healthCount}</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => onSelecting(!selecting)}
        aria-pressed={selecting}
        aria-label={selecting ? 'Cancel selection' : 'Select books'}
        title="Select books to edit together (or Ctrl-click a book)"
      >
        {selecting ? 'Cancel' : 'Select'}
      </button>
      <button type="button" onClick={() => void onScan()} disabled={scanning}>
        {scanning ? scanLabel : 'Rescan'}
      </button>
    </div>
  );
}
