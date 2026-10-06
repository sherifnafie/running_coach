package org.opencoach.app

import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Reads the athlete's own workouts from Android Health Connect (Samsung Health syncs into it),
 * on-device, with the athlete's permission (SPEC §10.5). The web app uploads the result to the
 * coach server as raw sync data (POST /v1/sync/health), where the coach parses it like any other file.
 *
 * JS API (window.Capacitor.Plugins.HealthConnect):
 *   availability() -> { status: "available" | "not_installed" | "update_required" }
 *   requestPermissions() -> { granted: boolean }
 *   readWorkouts({ from: ISO, to: ISO }) -> { sessions: [...] }
 */
@CapacitorPlugin(name = "HealthConnect")
class HealthConnectPlugin : Plugin() {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var launcher: ActivityResultLauncher<Set<String>>? = null
    private var pendingPermissionCall: PluginCall? = null

    private val permissions = setOf(
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
    )

    override fun load() {
        launcher = activity.registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            val call = pendingPermissionCall ?: return@registerForActivityResult
            pendingPermissionCall = null
            call.resolve(JSObject().put("granted", granted.containsAll(permissions)))
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    private fun client(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(context) else null

    @PluginMethod
    fun availability(call: PluginCall) {
        val status = when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
            else -> "not_installed"
        }
        call.resolve(JSObject().put("status", status))
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        val c = client() ?: return call.reject("Health Connect is not available on this device")
        scope.launch {
            val granted = c.permissionController.getGrantedPermissions()
            if (granted.containsAll(permissions)) {
                call.resolve(JSObject().put("granted", true))
            } else {
                activity.runOnUiThread {
                    pendingPermissionCall = call
                    launcher?.launch(permissions) ?: call.reject("permission launcher not ready")
                }
            }
        }
    }

    @PluginMethod
    fun readWorkouts(call: PluginCall) {
        val c = client() ?: return call.reject("Health Connect is not available on this device")
        val from = runCatching { Instant.parse(call.getString("from")) }.getOrNull() ?: return call.reject("from must be an ISO-8601 instant")
        val to = runCatching { Instant.parse(call.getString("to")) }.getOrNull() ?: Instant.now()
        scope.launch {
            try {
                val sessions = c.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(from, to))).records
                val out = JSArray()
                for (s in sessions) {
                    val range = TimeRangeFilter.between(s.startTime, s.endTime)
                    val distance = c.readRecords(ReadRecordsRequest(DistanceRecord::class, range)).records.sumOf { it.distance.inMeters }
                    val steps = c.readRecords(ReadRecordsRequest(StepsRecord::class, range)).records.sumOf { it.count }
                    val kcal = c.readRecords(ReadRecordsRequest(TotalCaloriesBurnedRecord::class, range)).records.sumOf { it.energy.inKilocalories }
                    val hr = JSArray()
                    for (r in c.readRecords(ReadRecordsRequest(HeartRateRecord::class, range)).records) {
                        for (sample in r.samples) hr.put(JSObject().put("t", sample.time.toString()).put("bpm", sample.beatsPerMinute))
                    }
                    out.put(
                        JSObject()
                            .put("id", s.metadata.id)
                            .put("start", s.startTime.toString())
                            .put("end", s.endTime.toString())
                            .put("startZoneOffset", s.startZoneOffset?.toString())
                            .put("exerciseType", s.exerciseType)
                            .put("title", s.title)
                            .put("notes", s.notes)
                            .put("sourceApp", s.metadata.dataOrigin.packageName)
                            .put("distanceM", distance)
                            .put("steps", steps)
                            .put("kcal", kcal)
                            .put("heartRate", hr),
                    )
                }
                call.resolve(JSObject().put("sessions", out).put("from", from.toString()).put("to", to.toString()))
            } catch (e: SecurityException) {
                call.reject("Health Connect permission missing: ${e.message}")
            } catch (e: Exception) {
                call.reject("Health Connect read failed: ${e.message}")
            }
        }
    }
}
