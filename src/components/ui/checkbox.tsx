import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    disabled?: boolean;
    id?: string;
    'aria-label'?: string;
    className?: string;
    size?: 'sm' | 'default';
}

/**
 * Checkbox custom. On gère `role="checkbox" aria-checked` à la main pour ne
 * pas ajouter Radix. L'icône Check apparaît avec une transition scale+opacity
 * pour un petit feedback visuel quand on coche / décoche.
 */
const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
    ({ checked, onCheckedChange, disabled, id, className, size = 'default', ...props }, ref) => {
        const dims = size === 'sm'
            ? { box: 'h-4 w-4', icon: 'h-3 w-3' }
            : { box: 'h-5 w-5', icon: 'h-3.5 w-3.5' };

        return (
            <button
                ref={ref}
                type="button"
                role="checkbox"
                id={id}
                aria-checked={checked}
                disabled={disabled}
                onClick={() => !disabled && onCheckedChange(!checked)}
                className={cn(
                    'relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border',
                    'transition-all duration-200 ease-out',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    dims.box,
                    checked
                        ? 'border-yellow-300 bg-yellow-300 shadow-[0_0_10px_rgba(253,224,71,0.35)]'
                        : 'border-white/20 bg-white/5 hover:border-white/40 hover:bg-white/10',
                    className,
                )}
                {...props}
            >
                <Check
                    aria-hidden="true"
                    strokeWidth={3}
                    className={cn(
                        dims.icon,
                        'text-black transition-all duration-150',
                        checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
                    )}
                />
            </button>
        );
    },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
