import { hap } from '../shared/hap.ts'
import type {
  Characteristic as CharacteristicClass,
  PlatformAccessory,
} from 'homebridge'
import { filter, map, tap } from 'rxjs/operators'
import { BaseAccessory } from '../shared/base-accessory.ts'
import { RestIot } from './rest-iot.ts'
import { RestIotRoutine } from '../shared/hatch-sleep-types.ts'
import { logError, logInfo } from '../shared/util.ts'

// How often to re-fetch the Favorites list from the cloud. The list isn't in
// the MQTT state stream, so polling is the only way to notice Favorites added
// or removed in the Hatch app without restarting Homebridge.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000

/**
 * Accessory for Gen 2 (IoT) Hatch devices. Exposes the device's Favorites
 * through the "fan hack": a single Fan service whose `On` characteristic is
 * play/stop and whose `RotationSpeed` selects which Favorite plays. The speed
 * scale is offset by one so that `0` means "off" (avoiding the collision where
 * HomeKit sends speed 0 on power-off): `0` = off, `1` = the first Favorite, …
 * `N` = the last Favorite, ordered by the Hatch app's `displayOrder`.
 */
export class RestIotAccessory extends BaseAccessory {
  // Favorites ordered by displayOrder; a Favorite's RotationSpeed value is its
  // index here plus one (slot 0 is reserved for "off").
  private favorites: RestIotRoutine[] = []
  // The Favorite the user last selected; remembered so toggling `On` replays it
  // and so we "hold last index" when the device reports something outside our set.
  private selectedIndex = 0
  private readonly restIot: RestIot

  constructor(device: RestIot, accessory: PlatformAccessory) {
    super(device, accessory)
    this.restIot = device

    const { Service, Characteristic } = hap,
      fanService = this.getService(Service.Fan),
      rotationSpeed = fanService.getCharacteristic(Characteristic.RotationSpeed)

    // Start with "off only" until the first fetch resolves and we know how many
    // slots to carve the 0-100% slider into.
    rotationSpeed.setProps({ minValue: 0, maxValue: 0, minStep: 1 })

    // On = play/stop. Turning on replays the currently selected Favorite.
    this.registerCharacteristic(
      fanService.getCharacteristic(Characteristic.On),
      device.onSomeContentPlaying,
      (on: boolean) => {
        if (on) {
          this.playSelected()
        } else {
          logInfo(`Turning off ${device.name}`)
          device.turnOff()
        }
      },
    )

    // RotationSpeed: 0 = off, N = the Nth Favorite. Reported from device state
    // (off reports 0; a known Favorite reports its slot; anything outside our
    // set holds the last shown value). Setting it plays that Favorite, or turns
    // off at 0 (select = play).
    this.registerCharacteristic(
      rotationSpeed,
      device.onRoutineSrId.pipe(
        map((srId) => {
          if (srId === 0) {
            return 0 // off
          }
          const index = this.favorites.findIndex((fav) => fav.id === srId)
          return index >= 0 ? index + 1 : -1 // -1 = outside our set, hold last
        }),
        filter((speed) => speed >= 0),
        tap((speed) => {
          if (speed >= 1) {
            this.selectedIndex = speed - 1
          }
        }),
      ),
      (speed: number) => {
        if (speed === 0) {
          logInfo(`Turning off ${device.name}`)
          device.turnOff()
        } else if (this.favorites[speed - 1]) {
          this.selectedIndex = speed - 1
          this.playSelected()
        }
      },
    )

    fanService.setPrimaryService(true)

    void this.refreshFavorites(rotationSpeed)
    const timer = setInterval(
      () => void this.refreshFavorites(rotationSpeed),
      REFRESH_INTERVAL_MS,
    )
    // Don't keep the process alive just for the poll.
    timer.unref?.()
  }

  private playSelected() {
    const favorite = this.favorites[this.selectedIndex]

    if (!favorite) {
      logError(
        `Cannot play a Favorite for ${this.restIot.name} - none are configured. Set Favorites in the Hatch app.`,
      )
      return
    }

    logInfo(`Playing Favorite "${favorite.name}" for ${this.restIot.name}`)
    this.restIot.turnOnRoutine(favorite.id)
  }

  private async refreshFavorites(rotationSpeed: CharacteristicClass) {
    let favorites: RestIotRoutine[]

    try {
      favorites = await this.restIot.fetchRoutines()
    } catch (e) {
      logError(`Failed to fetch Favorites for ${this.restIot.name}: ${e}`)
      return
    }

    const previousCount = this.favorites.length
    this.favorites = favorites

    if (favorites.length === 0) {
      logError(
        `No Favorites found for ${this.restIot.name}. Set some in the Hatch app, then restart Homebridge or wait for the next refresh.`,
      )
    }

    // Only touch the slider range when the count actually changed - HomeKit
    // tolerates mid-session setProps poorly, so we avoid it on the common
    // "names/order tweaked" case. maxValue is the Favorite count because slot 0
    // is "off" and Favorites occupy slots 1..N.
    if (favorites.length !== previousCount) {
      rotationSpeed.setProps({
        minValue: 0,
        maxValue: favorites.length,
        minStep: 1,
      })
    }

    if (favorites.length > 0) {
      logInfo(
        `Favorites for ${this.restIot.name}: ` +
          favorites.map((fav, i) => `[${i + 1}] ${fav.name}`).join(', '),
      )
    }
  }
}
