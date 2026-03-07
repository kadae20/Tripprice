<?php
/**
 * Plugin Name: Tripprice SEO Meta
 * Plugin URI:  https://tripprice.net
 * Description: Yoast SEO meta 필드(_yoast_wpseo_focuskw/title/metadesc/canonical)를 WP REST API에 노출. wp-publish.js 자동 주입용.
 * Version:     1.0.0
 * Author:      Tripprice
 * License:     Private
 *
 * 설치:
 *   WordPress 관리자 > 플러그인 > 새로 추가 > 플러그인 업로드
 *   → tripprice-seo-meta.zip 선택 → 지금 설치 → 활성화
 */

defined( 'ABSPATH' ) || exit;

add_action( 'rest_api_init', static function () {
    // 키별 스키마 및 sanitize 설정
    $meta_config = [
        '_yoast_wpseo_focuskw'   => [ 'maxLength' => 100,  'sanitize' => 'sanitize_text_field' ],
        '_yoast_wpseo_title'     => [ 'maxLength' => 100,  'sanitize' => 'sanitize_text_field' ],
        '_yoast_wpseo_metadesc'  => [ 'maxLength' => 300,  'sanitize' => 'sanitize_text_field' ],
        '_yoast_wpseo_canonical' => [ 'maxLength' => 2083, 'sanitize' => 'esc_url_raw'         ],
    ];

    foreach ( $meta_config as $key => $cfg ) {
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
            // $post_id 단위 편집 권한 체크 (전역 edit_posts 아님)
            'auth_callback'     => static function ( $allowed, $meta_key, $post_id ) {
                return current_user_can( 'edit_post', $post_id );
            },
        ] );
    }
}, 11 ); // priority 11: Yoast 자체 init(10) 이후 실행
