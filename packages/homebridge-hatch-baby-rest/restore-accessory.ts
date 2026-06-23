import { hap } from '../shared/hap.ts'
import type { PlatformAccessory } from 'homebridge'
import { BaseAccessory } from '../shared/base-accessory.ts'
import { Restore } from './restore.ts'
import { logInfo } from '../shared/util.ts'

export class RestoreAccessory extends BaseAccessory {
  constructor(restore: Restore, accessory: PlatformAccessory) {
    super(restore, accessory)

    const { Service, Characteristic } = hap,
      onOffService = this.getService(Service.Switch),
      stepName = 'bedtime step'

    this.registerCharacteristic(
      onOffService.getCharacteristic(Characteristic.On),
      restore.onSomeContentPlaying,
      (on) => {
        logInfo(
          `Turning ${on ? `on first ${stepName} for` : 'off'} ${restore.name}`,
        )
        if (on) {
          restore.turnOnRoutine()
        } else {
          restore.turnOff()
        }
      },
    )

    onOffService.setPrimaryService(true)
  }
}
