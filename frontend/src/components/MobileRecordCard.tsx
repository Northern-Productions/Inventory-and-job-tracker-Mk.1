import type {
  ButtonHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  Ref
} from 'react';

interface MobileRecordCardProps {
  className?: string;
  recordRef?: Ref<HTMLElement>;
}

interface MobileRecordHeaderProps {
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  onTitleClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  onTitleMouseEnter?: ButtonHTMLAttributes<HTMLButtonElement>['onMouseEnter'];
  onTitleFocus?: ButtonHTMLAttributes<HTMLButtonElement>['onFocus'];
  titleLink?: ReactNode;
}

interface MobileFieldProps {
  label: string;
  value: React.ReactNode;
}

export function MobileRecordCard({
  children,
  className = '',
  recordRef
}: PropsWithChildren<MobileRecordCardProps>) {
  return (
    <article ref={recordRef} className={`mobile-record-card ${className}`.trim()}>
      {children}
    </article>
  );
}

export function MobileRecordHeader({
  title,
  subtitle,
  badge,
  onTitleClick,
  onTitleMouseEnter,
  onTitleFocus,
  titleLink
}: MobileRecordHeaderProps) {
  return (
    <div className={`mobile-record-header ${badge ? 'mobile-record-header-with-badge' : ''}`.trim()}>
      <div className="mobile-record-heading">
        {titleLink ? (
          titleLink
        ) : onTitleClick ? (
          <button
            type="button"
            className="mobile-record-title-button"
            onClick={onTitleClick}
            onMouseEnter={onTitleMouseEnter}
            onFocus={onTitleFocus}
          >
            {title}
          </button>
        ) : (
          <div className="mobile-record-title-text">{title}</div>
        )}
        {subtitle ? <div className="mobile-record-subtitle">{subtitle}</div> : null}
      </div>
      {badge ? <div className="mobile-record-badge">{badge}</div> : null}
    </div>
  );
}

export function MobileFieldList({ children }: PropsWithChildren) {
  return <div className="mobile-field-list">{children}</div>;
}

export function MobileField({ label, value }: MobileFieldProps) {
  return (
    <div className="mobile-field-row">
      <span className="mobile-field-label">{label}</span>
      <div className="mobile-field-value">{value}</div>
    </div>
  );
}

export function MobileActionStack({ children }: PropsWithChildren) {
  return <div className="mobile-action-stack">{children}</div>;
}
