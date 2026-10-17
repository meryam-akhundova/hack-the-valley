// Sends accelerometer readings as "x,y,z" lines for the Slouch Dimmer extension.
// Sends "CAL" to tell the extension to save your current posture as "good":
//   - every time the board starts (so pressing RESET recalibrates)
//   - when an optional Grove button is pressed
#include <Wire.h>
#include "MMA7660.h"

// Optional: plug a Grove Button into D2 and change this to 2.
// Leave it at -1 if you don't have a button (an unconnected pin gives random presses).
const int BUTTON_PIN = -1;

MMA7660 accelemeter;
int lastButton = LOW;
unsigned long lastPress = 0;

void setup() {
  Serial.begin(9600);
  accelemeter.init();
  if (BUTTON_PIN >= 0) pinMode(BUTTON_PIN, INPUT);

  delay(300);              // let the sensor settle
  Serial.println("CAL");   // RESET button = recalibrate
}

void loop() {
  if (BUTTON_PIN >= 0) {
    int b = digitalRead(BUTTON_PIN);
    if (b == HIGH && lastButton == LOW && millis() - lastPress > 500) {
      lastPress = millis();
      Serial.println("CAL");
    }
    lastButton = b;
  }

  float ax, ay, az;
  accelemeter.getAcceleration(&ax, &ay, &az);

  Serial.print(ax);
  Serial.print(',');
  Serial.print(ay);
  Serial.print(',');
  Serial.println(az);

  delay(100);  // 10 readings per second
}
