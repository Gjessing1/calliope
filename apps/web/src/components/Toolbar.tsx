import type { JSX } from 'react';
interface ToolbarProps {
  search: string;
  sort: string;
  scanning: boolean;
  onSearch: (value: string) => void;
  onSort: (value: string) => void;
  onScan: () => void | Promise<void>;
}

export function Toolbar({
  search,
  sort,
  scanning,
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
      <button type="button" onClick={() => void onScan()} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Rescan'}
      </button>
    </div>
  );
}
