<?php
/**
 * Plugin Name: Tripprice SEO Meta
 * Plugin URI:  https://tripprice.net
 * Description: Yoast SEO meta 필드(_yoast_wpseo_focuskw/title/metadesc/canonical)를 WP REST API에 노출. wp-publish.js 자동 주입용.
 * Version:     1.1.0
 * Author:      Tripprice
 * License:     Private
 *
 * 설치:
 *   WordPress 관리자 > 플러그인 > 새로 추가 > 플러그인 업로드
 *   → tripprice-seo-meta.zip 선택 → 지금 설치 → 활성화
 */

defined( 'ABSPATH' ) || exit;

add_action( 'rest_api_init', static function () {
    // Yoast가 먼저 등록한 키를 unregister 후 show_in_rest=true 로 재등록
    $meta_config = [
        '_yoast_wpseo_focuskw'   => [ 'maxLength' => 100,  'sanitize' => 'sanitize_text_field' ],
        '_yoast_wpseo_title'     => [ 'maxLength' => 100,  'sanitize' => 'sanitize_text_field' ],
        '_yoast_wpseo_metadesc'  => [ 'maxLength' => 300,  'sanitize' => 'sanitize_text_field' ],
        '_yoast_wpseo_canonical' => [ 'maxLength' => 2083, 'sanitize' => 'esc_url_raw'         ],
    ];

    foreach ( $meta_config as $key => $cfg ) {
        // 이미 등록된 경우 해제 후 재등록 (Yoast 충돌 해소)
        unregister_post_meta( 'post', $key );
        register_post_meta( 'post', $key, [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => [
                'schema' => [
                    'type'      => 'string',
                    'maxLength' => $cfg['maxLength'],
                ],
            ],
            'default'           => '',
            'sanitize_callback' => $cfg['sanitize'],
            'auth_callback'     => static function ( $allowed, $meta_key, $post_id ) {
                return current_user_can( 'edit_post', $post_id );
            },
        ] );
    }
}, 99 ); // priority 99: Yoast(10~20) 완전히 이후에 실행
