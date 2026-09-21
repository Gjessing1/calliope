import type { JSX } from 'react';
interface ToolbarProps {
  search: string;
  sort: string;
  scanning: boolean;
  selecting: boolean;
  onSelecting: (on: boolean) => void;
  /** Books whose file and Audiobookshelf disagree; 0 hides the filter. */
  driftCount: number;
  driftOnly: boolean;
  onDriftOnly: (on: boolean) => void;
  onSearch: (value: string) => void;
  onSort: (value: string) => void;
  onScan: () => void | Promise<void>;
}

export function Toolbar({
  search,
  sort,
  scanning,
  selecting,
  onSelecting,
  driftCount,
  driftOnly,
  onDriftOnly,
  onSearch,
  onSort,
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
      <select value={sort} onChange={(e) => onSort(e.target.value)} aria-label="Sort by">
        <option value="title">Title</option>
        <option value="author">Author</option>
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
        {scanning ? 'Scanning…' : 'Rescan'}
      </button>
    </div>
  );
}
