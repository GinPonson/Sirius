import siriusMark from "../assets/brand/sirius-mark.svg";

type BrandMarkProps = {
  /** 视觉尺寸；容器尺寸由 CSS 控制，图标按容器铺满。 */
  size?: number;
  /** 仅装饰时保持 aria-hidden；需要语义时传标签。 */
  label?: string;
};

/**
 * Sirius 品牌标记：天狼星四芒星。
 * 应用图标、侧栏、登录页与启动屏共用同一资产，避免各处出现字母占位。
 */
export function BrandMark({ size = 18, label }: BrandMarkProps) {
  return (
    <img
      className="brand-mark-art"
      src={siriusMark}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
    />
  );
}
