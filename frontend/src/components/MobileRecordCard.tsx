import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

interface MobileRecordCardProps {
  className?: string;
}

interface MobileRecordHeaderProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  onTitleClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
}

interface MobileFieldProps {
  label: string;
  value: React.ReactNode;
}

export function MobileRecordCard({
  children,
  className = ''
}: PropsWithChildren<MobileRecordCardProps>) {
  return <article className={`mobile-record-card ${className}`.trim()}>{children}</article>;
}

export function MobileRecordHeader({
  title,
  subtitle,
  badge,
  onTitleClick
}: MobileRecordHeaderProps) {
  return (
    <div className="mobile-record-header">
      <div className="mobile-record-heading">
        {onTitleClick ? (
          <button type="button" className="mobile-record-title-button" onClick={onTitleClick}>
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
