import { useLayoutEffect, useRef, useState, type RefCallback } from 'react'

export interface Size {
  width: number
  height: number
}

/** Callback ref that also exposes the current node for imperative reads. */
export type MeasuredRef<T extends HTMLElement> = RefCallback<T> & { readonly current: T | null }

/**
 * Measures an element with ResizeObserver so SVG charts can lay out in real
 * pixels (crisp text at any viewport) instead of a fixed viewBox scale.
 *
 * The observer follows the node the ref is attached to. A chart that swaps
 * its DOM shape (a scrolling plot beside a fixed axis, then a plain plot)
 * would otherwise keep watching the detached node, which reports a width of
 * 0 and leaves the replacement blank.
 */
export function useMeasure<T extends HTMLElement>(): [MeasuredRef<T>, Size] {
  const nodeRef = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  // Bumps only when the attached node changes, so measuring a new size does
  // not re-run the effect. Re-running on every size change nests layout
  // updates until React aborts the render.
  const [nodeEpoch, setNodeEpoch] = useState(0)

  // Created once. Defining `current` on every render throws, because the
  // property is non-configurable after the first definition.
  const refHolder = useRef<MeasuredRef<T> | null>(null)
  if (refHolder.current === null) {
    const callback = ((node: T | null) => {
      if (nodeRef.current === node) return
      nodeRef.current = node
      setNodeEpoch((n) => n + 1)
    }) as MeasuredRef<T>
    Object.defineProperty(callback, 'current', {
      get: () => nodeRef.current,
    })
    refHolder.current = callback
  }
  const ref = refHolder.current

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    const update = () => {
      if (!node.isConnected) return
      const width = node.clientWidth
      const height = node.clientHeight
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [nodeEpoch])

  return [ref, size]
}
