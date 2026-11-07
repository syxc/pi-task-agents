// Test-only boundary shims. Steering receipt reservation and delivery bodies remain upstream code.
export const isUserSteeringProducer = () => false
export const captureAgentHostSteeringInput = ({ input, userMessageId }) => ({
  input,
  userMessageId
})
export const resolveGenuineUserQueryText = ({ input }) => input.text ?? ''
export const steeringMessageKey = (input) => input.idempotencyKey
export const steeringReceiptId = (input) => `${input.producerId}:${input.idempotencyKey}`
export const createUserMessageId = () => 'fixture-user-message'
