import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';

const ContentRowSkeleton: React.FC = () => {
  return (
    <div className="mb-8 animate-skeleton-fade">
      {/* Title (matches text-2xl font-bold) */}
      <div className="mb-4">
        <Skeleton width={192} height={32} />
      </div>

      <div className="relative">
        {/* Left chevron (greyed out, matches ContentRow.tsx:45-51) */}
        <div className="absolute left-0 top-0 bottom-0 z-10 hidden md:flex items-center justify-center w-16 bg-gradient-to-r from-black/50 to-transparent pointer-events-none">
        <ChevronLeft className="w-8 h-8 text-white opacity-20" />
        </div>

        {/* Cards row (8 posters, w-[150px], no titles below to match real component) */}
        <div className="flex overflow-hidden space-x-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="flex-none w-[150px]">
              <Skeleton variant="poster" width={150} />
            </div>
          ))}
        </div>

        {/* Right chevron */}
        <div className="absolute right-0 top-0 bottom-0 z-10 hidden md:flex items-center justify-center w-16 bg-gradient-to-l from-black/50 to-transparent pointer-events-none">
        <ChevronRight className="w-8 h-8 text-white opacity-20" />
        </div>
      </div>
    </div>
  );
};

export default ContentRowSkeleton;
