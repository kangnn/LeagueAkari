import { observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HextechRoomSearchFlowController } from './search-flow-controller'
import { HextechRoomSettings, HextechRoomState } from './state'

const operations = vi.hoisted(() => ({
  configure: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(() => ({ state: 'idle', running: false })),
  leave: vi.fn()
}))
vi.mock('./search-controller', () => ({
  SearchController: class {
    configure = operations.configure
    start = operations.start
    stop = operations.stop
    status = operations.status
    leave = operations.leave
  }
}))
vi.mock('@main/i18n', () => ({ i18next: { t: (key: string) => key } }))

type Dependencies = ConstructorParameters<typeof HextechRoomSearchFlowController>

describe('room search command lifecycle', () => {
  const controllers: HextechRoomSearchFlowController[] = []
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))

  function setup() {
    let finishLeave!: (value: { left: boolean }) => void
    operations.leave.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLeave = resolve
        })
    )
    const unsubscribe = vi.fn()
    const league = {
      state: observable({ connectionState: 'connected' }),
      data: { gameflow: observable({ phase: 'Lobby' }) },
      events: { on: vi.fn(() => unsubscribe) }
    }
    const state = new HextechRoomState()
    const controller = new HextechRoomSearchFlowController(
      league as unknown as Dependencies[0],
      new HextechRoomSettings(),
      state,
      { warn: vi.fn() } as unknown as Dependencies[3]
    )
    controllers.push(controller)
    controller.watch()
    return {
      controller,
      league,
      state,
      unsubscribe,
      finishLeave: () => finishLeave({ left: true })
    }
  }

  it('does not restart after stop while leaving is pending', async () => {
    const { controller, state, finishLeave } = setup()
    const pending = controller.command('continue')
    expect(state.busy).toBe(true)
    await controller.command('stop')
    finishLeave()
    await pending
    expect(operations.start).not.toHaveBeenCalled()
    expect(state.busy).toBe(false)
  })

  it.each(['disconnect', 'champion select'] as const)(
    'invalidates pending continue when the client enters %s',
    async (change) => {
      const { controller, league, finishLeave } = setup()
      const pending = controller.command('continue')
      runInAction(() => {
        if (change === 'disconnect') league.state.connectionState = 'disconnected'
        else league.data.gameflow.phase = 'ChampSelect'
      })
      finishLeave()
      await pending
      expect(operations.start).not.toHaveBeenCalled()
    }
  )

  it('removes its lobby subscriptions on disposal', () => {
    const { controller, unsubscribe, league } = setup()
    controller.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(league.events.on.mock.calls.length)
    expect(league.events.on).toHaveBeenCalledTimes(6)
  })
})
