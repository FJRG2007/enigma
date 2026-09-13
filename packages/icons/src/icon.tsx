import { forwardRef } from "react";
import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

export type IconProps = {
    className?: string;
    size?: number | string;
    /**
     * Accepted and ignored. These icons are filled, not stroked, so there is no
     * line to widen - and forwarding a number into the SVG `stroke` attribute,
     * which takes a COLOUR, paints the icon with an invalid value until it
     * disappears. Kept in the signature so a stroked set can be swapped out
     * without touching the call sites that pass it.
     */
    stroke?: number | string;
} & Omit<SVGProps<SVGSVGElement>, "stroke" | "size">;

/**
 * The shape of one icon component: a forwardRef so a parent can measure or
 * focus it, and so `typeof SomeIcon` types a parameter the way call sites expect.
 */
export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

/**
 * Build one icon component around its vendored body.
 *
 * The body is a constant written by the generator, never anything a caller
 * supplies, which is what makes dangerouslySetInnerHTML the right tool here
 * rather than a hole. Both paths of a duotone glyph carry fill="currentColor",
 * so colour comes from the surrounding text colour and nothing else.
 */
export function icon(name: string, body: string): Icon {
    const Component = forwardRef<SVGSVGElement, IconProps>(
        ({ className, size = 24, stroke: _stroke, ...rest }, ref) => (
            <svg
                ref={ref}
                className={className}
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden
                {...rest}
                dangerouslySetInnerHTML={{ __html: body }}
            />
        ),
    );
    Component.displayName = name;
    return Component;
}
