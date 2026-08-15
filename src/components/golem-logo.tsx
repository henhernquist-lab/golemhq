'use client'

import { motion } from 'framer-motion'

interface GolemLogoProps {
  size?: 'sm' | 'md' | 'lg'
  animated?: boolean
}

export function GolemLogo({ size = 'md', animated = true }: GolemLogoProps) {
  const sizeClasses = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-4xl',
  }
  const iconSizes = { sm: 'h-6 w-6', md: 'h-8 w-8', lg: 'h-10 w-10' }
  const svgSizes = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }

  const Wrapper = animated ? motion.div : 'div'
  const wrapperProps = animated
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { duration: 0.5 },
      }
    : {}

  return (
    <Wrapper {...wrapperProps} className="flex items-center gap-2">
      <div className="relative">
        <motion.div
          className={`flex ${iconSizes[size]} items-center justify-center rounded border border-primary/30 bg-surface-secondary`}
          animate={
            animated
              ? {
                  boxShadow: [
                    '0 0 4px rgba(0,255,102,0.15)',
                    '0 0 20px rgba(0,255,102,0.35)',
                    '0 0 4px rgba(0,255,102,0.15)',
                  ],
                }
              : {}
          }
          transition={{
            duration: 2.5,
            repeat: Infinity,
            ease: [0.2, 0, 0, 1],
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" className={svgSizes[size]} stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2L2 7L12 12L22 7L12 2Z" className="fill-primary/20 stroke-primary" />
            <path d="M2 17L12 22L22 17" className="stroke-primary" />
            <path d="M2 12L12 17L22 12" className="stroke-primary/60" />
          </svg>
        </motion.div>
      </div>
      <motion.div
        className={`font-display font-bold tracking-tight ${sizeClasses[size]}`}
        animate={
          animated
            ? {
                textShadow: [
                  '0 0 0px rgba(0,255,102,0)',
                  '0 0 8px rgba(0,255,102,0.25)',
                  '0 0 0px rgba(0,255,102,0)',
                ],
              }
            : {}
        }
        transition={{
          duration: 2.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        <span className="text-foreground">Golem</span>{' '}
        <span className="text-primary">HQ</span>
      </motion.div>
    </Wrapper>
  )
}
