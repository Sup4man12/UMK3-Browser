package com.umk3;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class Umk3ApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(Umk3ApiApplication.class, args);
    }
}
