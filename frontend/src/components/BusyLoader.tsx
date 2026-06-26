import '../styles/BusyLoader.css';

interface BusyLoaderProps {
  /** Text shown below the animation. Optional. */
  label?: string;
  /** Visual size. Default `'md'`. */
  size?: 'sm' | 'md' | 'lg';
  /** Variant — `'dots'` (pulsing dots) or `'ring'` (spinning ring). Default `'dots'`. */
  variant?: 'dots' | 'ring';
  /**
   * `'block'` centres the loader in a tall flex container (full-page feel).
   * `'inline'` lays it out as inline-flex (use inside small slots).
   * Default `'block'`.
   */
  layout?: 'block' | 'inline';
  /** Optional className passthrough for parent positioning tweaks. */
  className?: string;
}

export default function BusyLoader({
  label,
  size    = 'md',
  variant = 'dots',
  layout  = 'block',
  className = '',
}: BusyLoaderProps) {
  return (
    <div className={`busy-loader busy-loader--${layout} busy-loader--${size} ${className}`}>
      {variant === 'dots' ? (
        <div className="busy-loader__dots" aria-label="Loading">
          <span /><span /><span />
        </div>
      ) : (
        <div className="busy-loader__ring" aria-label="Loading" />
      )}
      {label && <div className="busy-loader__label">{label}</div>}
    </div>
  );
}
