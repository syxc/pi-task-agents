/** Bounds fixture cleanup so one stuck operation cannot stall the whole test process. */
export async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
  }
}
