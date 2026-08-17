interface NexussLogoProps {
  size?: number;
  color?: string;
  className?: string;
}

export function NexussLogo({ size = 28, color = "#ffffff", className = "" }: NexussLogoProps) {
  return (
    <svg
      width={size}
      height={size * (70 / 100)}
      viewBox="0 0 140 98"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}
      aria-hidden="true"
    >
      <g fill={color}>
        <path d="M52.5 7L7 52.5L52.5 98L73.5 77L52.5 56L31.5 52.5L52.5 31.5L66.5 45.5L80.5 31.5L52.5 7Z" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M52.5 0L0 52.5L52.5 105L70 87.5L52.5 70L35 52.5L52.5 35L70 52.5L87.5 35L52.5 0ZM52.5 17.5L17.5 52.5L52.5 87.5L61.25 78.75L52.5 70L52.5 52.5L52.5 35L61.25 26.25L52.5 17.5Z"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M87.5 0L70 17.5L87.5 35L105 52.5L87.5 70L70 52.5L52.5 70L87.5 105L140 52.5L87.5 0ZM87.5 17.5L122.5 52.5L87.5 87.5L78.75 78.75L87.5 70L87.5 35L78.75 26.25L87.5 17.5Z"
        />
      </g>
    </svg>
  );
}
